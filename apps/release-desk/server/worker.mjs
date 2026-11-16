import { randomUUID } from 'node:crypto';
import { validatePull } from './github.mjs';
import { reviewInput, allApprove } from './reviews.mjs';
import { DeskError, ensure, safeError } from './errors.mjs';
import { ROLES } from './config.mjs';

export class Worker {
  constructor({ config, store, github, reviews }) { Object.assign(this, { config, store, github, reviews }); this.owner = randomUUID(); this.busy = false; this.stopped = false; }
  start() { this.store.recoverMerges(); this.timer = setInterval(() => void this.tick(), this.config.pollMs); this.timer.unref(); void this.tick(); }
  stop() { this.stopped = true; clearInterval(this.timer); }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true; let run;
    try {
      this.store.recoverMerges();
      run = this.store.claim(this.owner); if (!run) return;
      const heartbeat = setInterval(() => this.store.renew(run.id, this.owner), 30_000); heartbeat.unref();
      let deferred = false;
      try {
        await this.process(run);
        if (this.store.ownsLease(run.id, this.owner)) this.store.updateLeasedRun(run.id, this.owner, { githubReadFailures: 0, githubRetryAt: null });
      }
      catch (error) {
        if (!this.store.ownsLease(run.id, this.owner)) return;
        run = this.store.getRun(run.id);
        if (error instanceof DeskError && error.code === 'GITHUB_READ_UNAVAILABLE') {
          const remaining = this.config.maxRunMs - (Date.now() - Date.parse(run.createdAt));
          if (remaining > 0) {
            const failures = (run.githubReadFailures || 0) + 1;
            const delay = Math.min(remaining, Math.max(Math.min(15_000 * 2 ** Math.min(failures - 1, 2), 60_000), error.retryAfterMs || 0));
            this.store.updateLeasedRun(run.id, this.owner, { status: 'running', stage: 'waiting_for_github', error: null, githubReadFailures: failures, githubRetryAt: new Date(Date.now() + delay).toISOString() });
            // Keep the durable lease until the cooldown expires. Releasing it would let
            // every worker tick reclaim this oldest run and starve other queued reviews.
            deferred = this.store.renew(run.id, this.owner, delay);
            this.store.audit('worker', 'review.read_deferred', { runId: run.id, failures, retryAfterMs: delay });
            return;
          }
          error = new DeskError('REVIEW_TIMEOUT', 'The review exceeded its time limit.');
        }
        const stale = ['STALE_HEAD', 'STALE_BASE', 'PR_INELIGIBLE', 'PR_SCOPE'].includes(error.code);
        this.store.updateLeasedRun(run.id, this.owner, { status: stale ? 'stale' : 'failed', stage: 'finished', error: safeError(error), githubRetryAt: null });
        this.store.audit('worker', 'review.failed', { runId: run.id, code: error.code || 'UPSTREAM_ERROR' });
        try { this.onFinished?.(this.store.getRun(run.id)); } catch { /* informational only */ }
        try { await this.github.finishCheck(run, false, safeError(error)); } catch { this.store.audit('worker', 'check.update_failed', { runId: run.id }); }
      } finally { clearInterval(heartbeat); if (!deferred) this.store.release(run.id, this.owner); }
    } catch { /* Transient SQLite availability: leave the durable lease for recovery. No approval occurs. */ }
    finally { this.busy = false; }
  }
  async process(original) {
    const update = changes => this.store.updateLeasedRun(original.id, this.owner, changes);
    let run = this.store.getRun(original.id);
    const reviewMode = run.reviewMode || 'live';
    ensure(reviewMode === this.config.reviewMode, 'REVIEW_MODE_CHANGED', 'The configured reviewer mode changed. Start a fresh review.');
    ensure(Date.now() - Date.parse(run.createdAt) < this.config.maxRunMs, 'REVIEW_TIMEOUT', 'The review exceeded its time limit.');
    const pr = await this.github.getPull(run.prNumber); validatePull(pr, this.config, run.headSha, run.baseSha);
    ensure(run.baseBranch && pr.base.ref === run.baseBranch, 'PR_SCOPE', 'The PR target changed during review.');
    ensure(await this.github.getBranchSha(run.baseBranch) === run.baseSha, 'STALE_BASE', `${run.baseBranch} changed during review.`);
    run = update({ status: 'running', stage: 'reviewing', githubRetryAt: null });
    if (!run.checkId) run = update({ checkId: await this.github.startCheck(run) });
    if (!run.dispatchAt) {
      // Record the intent before the remote side effect. On restart, poll this ID; never blindly dispatch again.
      run = update({ dispatchAt: new Date().toISOString(), stage: 'dispatching' });
      await this.github.dispatch(run);
    }
    if (!allApprove(run.reviews, reviewMode)) {
      let input = '';
      if (reviewMode === 'live') {
        const files = await this.github.immutableFiles(run.baseSha, run.headSha);
        input = reviewInput(files, this.config);
      }
      if (!run.reviews.length) run = update({ reviews: ROLES.map(role => ({ role, status: 'pending', simulated: reviewMode === 'demo', verdict: null, summary: '', findings: [] })) });
      run = update({ stage: reviewMode === 'demo' ? 'demo_reviewing' : 'reviewing' });
      const reviews = await this.reviews.run(input, { mode: reviewMode, existing: run.reviews, onProgress: result => {
        const current = this.store.getRun(run.id);
        update({ reviews: current.reviews.map(review => review.role === result.role ? result : review) });
      } });
      run = update({ reviews, stage: 'waiting_for_ci' });
      ensure(allApprove(reviews, reviewMode), 'AI_NOT_APPROVED', reviewMode === 'demo' ? 'The simulated reviewers did not complete successfully.' : 'One or more AI reviewers requested changes or could not complete review.');
    }
    ensure(allApprove(run.reviews, reviewMode), 'AI_NOT_APPROVED', 'All three reviewers must complete in the run’s recorded mode.');
    const ci = run.ci.runId ? await this.github.workflowEvidence(run, run.ci.runId) : await this.github.findWorkflowRun(run);
    if (!ci) {
      ensure(Date.now() - Date.parse(run.dispatchAt) < 5 * 60_000, 'CI_NOT_FOUND', 'No uniquely correlated workflow appeared after dispatch.');
      return;
    }
    run = update({ ci, stage: 'waiting_for_ci' });
    if (ci.status !== 'completed') return;
    ensure(ci.conclusion === 'success', 'CI_FAILED', 'The trusted CI workflow did not succeed.');
    const fresh = await this.github.getPull(run.prNumber); validatePull(fresh, this.config, run.headSha, run.baseSha);
    ensure(await this.github.getBranchSha(run.baseBranch) === run.baseSha, 'STALE_BASE', `${run.baseBranch} changed before review completed.`);
    ensure(Date.now() - Date.parse(run.createdAt) < this.config.maxRunMs, 'REVIEW_TIMEOUT', 'The review exceeded its time limit.');
    ensure(this.store.ownsLease(run.id, this.owner), 'LEASE_LOST', 'The worker lease expired.');
    await this.github.finishCheck(run, true, reviewMode === 'demo' ? 'Real trusted GitHub CI passed for this exact head and base. All three AI reviewer results were SIMULATED for the demo. No AI code review was performed.' : 'Trusted CI and all three independent AI reviewers approved this exact head and base.');
    update({ status: 'passed', stage: 'finished', error: null });
    try { this.onFinished?.(this.store.getRun(run.id)); } catch { /* the flow retries on the next event */ }
    this.store.audit('worker', 'review.passed', { runId: run.id, headSha: run.headSha, baseSha: run.baseSha, reviewMode });
  }
}
