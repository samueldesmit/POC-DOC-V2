import { DeskError, safeError } from './errors.mjs';
import { releaseTargets } from './config.mjs';
import { validatePull } from './github.mjs';

// The merchant-facing flow on top of the release gates. A merchant says what
// they want ("put this in the test version", "make it live") once; the flow
// then runs the checks and merges as soon as they pass. It never skips a
// gate: merging still goes through Service.merge with all its re-checks.
export const SYSTEM = Object.freeze({ id: 'auto', canMutate: true, system: true });
const ACTIVE = new Set(['queued', 'running', 'merging', 'merge_unknown']);

export class Flow {
  constructor({ config, store, github, service, schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; } }) {
    Object.assign(this, { config, store, github, service, schedule });
    this.db = store.db; this.inFlight = new Map(); this.retries = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS intents(pr INTEGER PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, problem TEXT);`);
  }
  intent(number) {
    const row = this.db.prepare('SELECT * FROM intents WHERE pr=?').get(number);
    return row ? { pr: row.pr, actor: { id: row.actor, canMutate: true }, kind: row.kind, createdAt: new Date(row.created).toISOString(), problem: row.problem } : null;
  }
  setIntent(number, actor, kind) {
    this.db.prepare('INSERT INTO intents(pr,actor,kind,created,problem) VALUES(?,?,?,?,NULL) ON CONFLICT(pr) DO UPDATE SET actor=excluded.actor,kind=excluded.kind,created=excluded.created,problem=NULL').run(number, actor.id, kind, Date.now());
    this.store.audit(actor.id, 'intent.set', { pr: number, kind });
    this.store.bump();
  }
  clearIntent(number) { this.db.prepare('DELETE FROM intents WHERE pr=?').run(number); this.store.bump(); }
  problem(number, message) { this.db.prepare('UPDATE intents SET problem=? WHERE pr=?').run(message, number); this.store.bump(); }

  // "Put this change in the test version": merge into staging once checks pass.
  async publish(number, actor) {
    this.service.requireReviewer(actor);
    const pr = await this.github.getPull(number);
    validatePull(pr, this.config);
    if (pr.base.ref === this.config.liveBranch) return this.goLive(actor);
    this.setIntent(number, actor, 'staging');
    await this.progress(number);
    return { number, intent: this.intent(number) };
  }
  // "Make the test version live": bring staging up to date with live, open (or
  // reuse) the single release PR, and merge it once its checks pass.
  async goLive(actor) {
    this.service.requireReviewer(actor);
    await this.syncStaging();
    const release = await this.service.createRelease(actor);
    this.setIntent(release.number, actor, 'live');
    await this.progress(release.number);
    return { number: release.number, intent: this.intent(release.number) };
  }
  // Live can move on its own (theme editor saves on the live theme). Merge it
  // into staging so the release stays up to date and staging shows live content.
  // Requires the app to be allowed to push to staging (ruleset bypass).
  async syncStaging() {
    const { stagingBranch: staging, liveBranch: live } = this.config;
    try { await this.github.mergeBranches(staging, live, `Bring ${staging} up to date with ${live}`); }
    catch (error) {
      if (error.httpStatus === 409) throw new DeskError('SYNC_CONFLICT', `The test version and the live shop both changed the same file. Strix needs to combine them before this can go live.`, 409);
      throw error;
    }
  }
  // Drive one PR forward as far as it can go right now. Safe to call often:
  // concurrent calls for one PR collapse into one.
  progress(number) {
    if (this.inFlight.has(number)) return this.inFlight.get(number);
    const work = this.step(number).catch(error => {
      if (this.intent(number)) this.problem(number, error instanceof DeskError ? error.message : safeError(error));
      this.store.audit('auto', 'flow.error', { pr: number, code: error.code || 'ERROR' });
    }).finally(() => this.inFlight.delete(number));
    this.inFlight.set(number, work);
    return work;
  }
  retryLater(number, ms = 15_000) {
    const count = (this.retries.get(number) || 0) + 1;
    if (count > 12) { this.retries.delete(number); return; }
    this.retries.set(number, count);
    this.schedule(() => void this.progress(number), ms);
  }
  async step(number) {
    const pr = await this.github.getPull(number);
    let intent = this.intent(number);
    if (pr.state !== 'open' || pr.draft) { if (intent) this.clearIntent(number); return; }
    if (!releaseTargets(this.config).includes(pr.base?.ref)) return;
    try { validatePull(pr, this.config); } catch { return; }
    // Changes Claude made go into the test version by themselves once they pass:
    // the test version is not visible to customers, and that is where they look at it.
    if (!intent && pr.base.ref === this.config.stagingBranch && /^claude\//.test(pr.head.ref)) { this.setIntent(number, SYSTEM, 'staging'); intent = this.intent(number); }
    if (pr.mergeable_state === 'dirty') {
      if (intent) this.problem(number, 'This change conflicts with another change. Strix needs to combine them.');
      return;
    }
    if (pr.mergeable_state === 'behind') {
      // Bring the change up to date; the new commit triggers the build and a fresh check.
      if (pr.base.ref === this.config.liveBranch) await this.syncStaging();
      else await this.github.updateBranch(number, pr.head.sha);
      return;
    }
    const run = this.store.listRuns(number, 1)[0];
    const current = run && run.headSha === pr.head.sha && run.baseSha === pr.base.sha;
    if (current && ACTIVE.has(run.status)) return;
    if (current && run.status === 'passed') {
      if (!intent) return;
      try {
        await this.service.merge(number, { headSha: pr.head.sha, runId: run.id }, intent.actor);
        this.clearIntent(number); this.retries.delete(number);
        this.store.audit(intent.actor.id, 'flow.merged', { pr: number, into: pr.base.ref });
        // Changes waiting for staging are now behind it; nudge them along.
        if (pr.base.ref === this.config.stagingBranch) for (const other of this.waiting()) if (other !== number) void this.progress(other);
      } catch (error) {
        // GitHub computes mergeability asynchronously right after a check passes.
        if (['MERGE_BLOCKED', 'PR_BUSY'].includes(error.code)) { this.retryLater(number); return; }
        throw error;
      }
      return;
    }
    if (current && run.status === 'failed') {
      if (intent) this.problem(number, 'The automatic check found a problem. Ask Claude to fix it; the change is checked again after the fix.');
      return;
    }
    // A new version of the change (for example Claude's fix) starts with a clean slate.
    if (intent?.problem) this.problem(number, null);
    await this.service.test(number, pr.head.sha, intent?.actor || SYSTEM);
  }
  // "Remove from the test version": a revert of that change, checked and merged like any other.
  async remove(number, actor) {
    this.service.requireReviewer(actor);
    const pr = await this.github.getPull(number);
    if (!(pr.merged && pr.base?.ref === this.config.stagingBranch)) throw new DeskError('NOT_IN_TEST_VERSION', 'This change is not in the test version.', 409);
    const comparison = await this.github.compareBranches(this.config.liveBranch, this.config.stagingBranch, 100);
    if (!(comparison.commits || []).some(commit => commit.sha === pr.merge_commit_sha)) throw new DeskError('ALREADY_LIVE', 'This change is already live. Ask Claude to undo it instead.', 409);
    const revert = await this.github.revertPull(pr.node_id, `Remove: ${pr.title}`, `Removes #${number} from the test version (requested in Release Desk).`);
    this.setIntent(revert.number, actor, 'staging');
    this.store.audit(actor.id, 'flow.remove', { pr: number, revert: revert.number });
    await this.progress(revert.number);
    return { number: revert.number };
  }
  // "Discard": stop a change that has not reached the test version yet.
  async discard(number, actor) {
    this.service.requireReviewer(actor);
    const pr = await this.github.getPull(number);
    if (!(pr.state === 'open' && pr.base?.ref === this.config.stagingBranch)) throw new DeskError('NOT_OPEN', 'This change can no longer be discarded.', 409);
    await this.github.closePull(number);
    this.clearIntent(number);
    this.store.audit(actor.id, 'flow.discard', { pr: number });
    return { closed: true };
  }
  waiting() { return this.db.prepare('SELECT pr FROM intents').all().map(row => row.pr); }

  // GitHub events that can move a PR forward.
  onWebhook(event, payload) {
    if (event === 'workflow_run' && payload.action === 'completed') {
      for (const pr of payload.workflow_run?.pull_requests || []) if (Number.isInteger(pr.number)) this.schedule(() => void this.progress(pr.number), 3_000);
    }
    if (event === 'pull_request' && ['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(payload.action) && Number.isInteger(payload.number)) {
      // Fallback for repositories without a build workflow on pull requests.
      this.schedule(() => void this.progress(payload.number), 120_000);
    }
  }
  onRunFinished(run) { if (run?.prNumber) this.schedule(() => void this.progress(run.prNumber), 1_000); }
  view(number) { const intent = this.intent(number); return intent ? { kind: intent.kind, since: intent.createdAt, problem: intent.problem } : null; }
}
