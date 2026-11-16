import { randomUUID } from 'node:crypto';
import { setupBlockers, releaseTargets, stageOf } from './config.mjs';
import { ensure, isSha, DeskError, nowIso } from './errors.mjs';
import { validatePull } from './github.mjs';
import { allApprove } from './reviews.mjs';

const MERGEABLE = new Set(['clean', 'unstable']);
export function eligibility(pr, run, protection, config) {
  const reasons = [];
  try { validatePull(pr, config); } catch (error) { reasons.push(error.message); }
  if (!protection?.ready) reasons.push(`${pr.base?.ref || 'The target branch'} must require an up-to-date, app-pinned Release Desk check and enforce protection for administrators.`);
  if (!run || run.status !== 'passed') reasons.push('A completed passing review is required.');
  if (run && (run.headSha !== pr.head.sha || run.baseSha !== pr.base.sha)) reasons.push(`The PR or ${pr.base?.ref || 'its base'} changed after this review.`);
  if (run && (run.reviewMode || 'live') !== config.reviewMode) reasons.push('The configured reviewer mode changed. Start a fresh review.');
  if (run && (!allApprove(run.reviews, run.reviewMode || 'live') || run.ci?.status !== 'completed' || run.ci?.conclusion !== 'success' || !run.checkId)) reasons.push(config.reviewMode === 'demo' ? 'Real CI must pass and all three explicitly simulated reviewers must finish for this exact revision.' : 'CI and all three AI reviewers must approve this exact revision.');
  // 'unstable' = all required checks passed but an optional one did not (for example a
  // build run on a bot commit waiting for approval). GitHub still enforces the required checks.
  if (pr.mergeable !== true || !MERGEABLE.has(pr.mergeable_state)) reasons.push('GitHub has not confirmed a clean, unblocked merge.');
  return { allowed: reasons.length === 0, reasons };
}
export function pullView(pr, run, protection, config) {
  // GitHub's list response carries merged_at but may omit the merged boolean.
  // Repository history is authoritative even when somebody merged outside this app.
  const merged = pr.merged === true || Boolean(pr.merged_at);
  return { number: pr.number, stage: stageOf(config, pr.base?.ref), headBranch: pr.head?.ref || '', title: pr.title, url: pr.html_url, author: pr.user?.login || '', draft: pr.draft, state: pr.state, status: merged ? 'merged' : pr.state, merged, createdAt: pr.created_at || null, closedAt: pr.closed_at || null, mergedAt: pr.merged_at || null, mergedBy: pr.merged_by?.login || null, mergeCommitSha: merged ? pr.merge_commit_sha || null : null, headSha: pr.head.sha, baseSha: pr.base.sha, baseBranch: pr.base.ref, updatedAt: pr.updated_at, mergeable: pr.mergeable ?? null, mergeState: pr.mergeable_state || 'unknown', latestRun: run || null, mergeEligibility: eligibility(pr, run, protection, config) };
}
export class Service {
  constructor({ config, store, github, previewService = null, connectorStore = null }) { this.config = config; this.store = store; this.github = github; this.previewService = previewService; this.connectorStore = connectorStore; }
  withRequester(view) {
    const change = this.connectorStore?.changeForPull(view.number);
    const intent = this.flow?.view(view.number) || null;
    return { ...view, ...(change ? { requestedBy: change.name, request: change.request } : {}), intent };
  }
  requireReviewer(actor) { ensure(actor.canMutate, 'FORBIDDEN', 'Your Shopify user is not authorized to run tests or merge.', 403); }
  async locked(pr, action) {
    const owner = randomUUID(); ensure(this.store.lock(pr, owner), 'PR_BUSY', 'Another action is already in progress for this PR.');
    const heartbeat = setInterval(() => this.store.renewLock(pr, owner), 30_000); heartbeat.unref();
    const assertLock = () => ensure(this.store.ownsLock(pr, owner), 'ACTION_LEASE_LOST', 'The action lease expired. Refresh before retrying.');
    try { return await action(assertLock); } finally { clearInterval(heartbeat); this.store.unlock(pr, owner); }
  }
  async dashboard(actor) {
    const blockers = setupBlockers(this.config);
    let pulls = [], history = [], historyError = null, release = null;
    const protections = Object.fromEntries(releaseTargets(this.config).map(branch => [branch, { ready: false }]));
    if (!blockers.some(blocker => ['GITHUB_AUTH_MISSING', 'REPOSITORY_MISSING'].includes(blocker.code))) {
      try {
        const results = await Promise.allSettled([this.github.listPulls(), this.github.protection(this.config.stagingBranch), this.github.protection(this.config.liveBranch), this.github.listHistory(), this.github.compareBranches(this.config.liveBranch, this.config.stagingBranch, 100)]);
        if (results[1].status === 'fulfilled') protections[this.config.stagingBranch] = results[1].value;
        if (results[2].status === 'fulfilled') protections[this.config.liveBranch] = results[2].value;
        // Pull-list responses omit GitHub's computed mergeability. Detail endpoint refreshes that on selection.
        if (results[0].status === 'fulfilled') pulls = results[0].value.map(pr => this.withRequester(pullView(pr, this.store.listRuns(pr.number, 1)[0], protections[pr.base.ref], this.config)));
        else blockers.push({ code: 'GITHUB_UNAVAILABLE', message: 'Open pull requests could not be loaded.' });
        if (results[3].status === 'fulfilled') history = results[3].value.filter(pr => pr.state === 'closed' && releaseTargets(this.config).includes(pr.base?.ref)).slice(0, 50).map(pr => this.withRequester(pullView(pr, this.store.listRuns(pr.number, 1)[0], protections[pr.base.ref], this.config)));
        else historyError = 'Recent pull-request history could not be loaded. Try refreshing.';
        if (results[4].status === 'fulfilled') {
          const openRelease = pulls.find(pr => pr.stage === 'live');
          // Which changes are on staging but not live: squash merges end their first line with "(#123)".
          const included = [...new Set((results[4].value.commits || []).map(commit => String(commit.commit?.message || '').split('\n')[0].match(/\(#(\d+)\)\s*$/)?.[1]).filter(Boolean).map(Number))];
          release = { aheadBy: results[4].value.ahead_by ?? 0, behindBy: results[4].value.behind_by ?? 0, openPull: openRelease ? openRelease.number : null, pulls: included };
        }
      } catch { blockers.push({ code: 'GITHUB_UNAVAILABLE', message: 'GitHub status could not be loaded.' }); }
    }
    // Every open change gets an automatic check without anyone asking: start one
    // for any PR whose current commit has none yet (the flow ignores busy PRs).
    // Also nudge every change the merchant already asked to publish (the flow is idempotent).
    if (this.flow && !blockers.length) for (const pull of pulls) if (!pull.draft && (pull.intent || !pull.latestRun || pull.latestRun.headSha !== pull.headSha || pull.latestRun.baseSha !== pull.baseSha)) void this.flow.progress(pull.number);
    for (const [branch, protection] of Object.entries(protections)) if (!protection.ready) blockers.push({ code: 'BRANCH_PROTECTION_REQUIRED', message: `${branch} needs strict, administrator-enforced protection requiring the Release Desk check from this GitHub App.` });
    return { shop: this.config.shop, actor: { id: actor.id, canMutate: actor.canMutate }, repository: this.config.repository, branches: { staging: this.config.stagingBranch, live: this.config.liveBranch }, release, themes: { stagingPreviewUrl: this.config.stagingThemeId ? `https://${this.config.shop}/?preview_theme_id=${this.config.stagingThemeId}` : null, liveUrl: `https://${this.config.shop}/` }, reviewMode: this.config.reviewMode, setup: { ready: blockers.length === 0, blockers }, pulls, history, historyError, runs: this.store.listRuns(), notifications: this.store.notifications(), deployment: { description: `Changes are merged into ${this.config.stagingBranch} first and tested on the staging theme. Releasing merges ${this.config.stagingBranch} into ${this.config.liveBranch}, which the live theme follows.` }, updatedAt: nowIso() };
  }
  async detail(number) {
    const pr = await this.github.getPull(number);
    const protection = releaseTargets(this.config).includes(pr.base?.ref) ? await this.github.protection(pr.base.ref) : { ready: false };
    let files = [], filesUnavailableReason = null;
    try { files = await this.github.files(number); }
    catch (error) {
      // A large historical PR must remain inspectable even when its file list
      // exceeds live-review limits. Never fabricate a partial complete diff.
      if (pr.state !== 'closed') throw error;
      filesUnavailableReason = error instanceof DeskError ? error.message : 'The historical file list could not be loaded.';
    }
    const runs = this.store.listRuns(number);
    const previewState = this.previewsStatus(number);
    // Who did what: every commit with its author, and the Claude request behind the PR.
    let commits = [];
    try { commits = (await this.github.pullCommits(number)).map(item => ({ sha: item.sha, message: String(item.commit?.message || '').split('\n')[0].slice(0, 200), author: item.commit?.author?.name || item.author?.login || 'Unknown', date: item.commit?.author?.date || null, url: item.html_url })); } catch { commits = []; }
    const change = this.connectorStore?.changeForPull(number) || null;
    return { pull: pullView(pr, runs[0], protection, this.config), files: files.map(file => ({ path: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, url: file.blob_url })), filesUnavailableReason, runs, commits, request: change ? { by: change.name, text: change.request, changeId: change.id } : null, previews: previewState.previews, previewsConfigured: previewState.configured };
  }
  previewsStatus(number) { return this.previewService?.status(number) || { previews: null, configured: false }; }
  async generatePreviews(number, headSha, actor) {
    this.requireReviewer(actor);
    ensure(this.previewService, 'PREVIEW_UNAVAILABLE', 'Store previews are not configured.', 503);
    return this.previewService.generate(number, headSha, actor);
  }
  async test(number, headSha, actor) {
    this.requireReviewer(actor); ensure(isSha(headSha), 'INVALID_SHA', 'Supply the full PR head SHA.', 400);
    ensure(setupBlockers(this.config).length === 0, 'SETUP_INCOMPLETE', 'Required integration credentials or reviewer configuration are missing.', 503);
    return this.locked(number, async assertLock => {
      const pr = await this.github.getPull(number); validatePull(pr, this.config, headSha);
      ensure(await this.github.getBranchSha(pr.base.ref) === pr.base.sha, 'STALE_BASE', `${pr.base.ref} changed while starting the review. Refresh and retry.`);
      ensure(!this.store.listRuns(number).some(run => run.status === 'merge_unknown'), 'MERGE_UNKNOWN', 'A previous merge has an uncertain outcome. Resolve it in GitHub before proceeding.');
      assertLock();
      return this.store.enqueue(pr, actor, this.config);
    });
  }
  async merge(number, { headSha, runId }, actor) {
    this.requireReviewer(actor); ensure(isSha(headSha) && typeof runId === 'string', 'INVALID_REQUEST', 'A full head SHA and review run ID are required.', 400);
    ensure(setupBlockers(this.config).length === 0, 'SETUP_INCOMPLETE', 'Required integrations are not configured.', 503);
    return this.locked(number, async assertLock => {
      let run = this.store.getRun(runId);
      ensure(run && run.prNumber === number && run.headSha === headSha, 'RUN_MISMATCH', 'This run does not belong to the selected PR revision.');
      const latest = this.store.listRuns(number, 1)[0];
      ensure(latest?.id === run.id && run.status === 'passed', 'RUN_NOT_APPROVED', 'The latest review must have passed.');
      ensure(!this.store.listRuns(number).some(item => ['queued', 'running', 'merging', 'merge_unknown'].includes(item.status)), 'RUN_IN_PROGRESS', 'A review or unresolved merge is still in progress.');
      const [pr, protection] = await Promise.all([this.github.getPull(number), this.github.protection(run.baseBranch)]);
      validatePull(pr, this.config, run.headSha, run.baseSha);
      ensure(pr.base.ref === run.baseBranch, 'PR_SCOPE', 'The PR target changed. Start a new review.');
      const ready = eligibility(pr, run, protection, this.config); ensure(ready.allowed, 'MERGE_BLOCKED', ready.reasons.join(' '));
      // Refresh both CI evidence and app-owned check; a rerun or cancelled workflow invalidates approval.
      const ci = await this.github.workflowEvidence(run, run.ci.runId);
      ensure(ci.status === 'completed' && ci.conclusion === 'success' && ci.attempt === run.ci.attempt, 'CI_CHANGED', 'The trusted workflow changed after approval. Run a fresh review.');
      await this.github.verifyCheck(run);
      const fresh = await this.github.getPull(number); validatePull(fresh, this.config, run.headSha, run.baseSha);
      ensure(fresh.mergeable === true && MERGEABLE.has(fresh.mergeable_state), 'MERGE_BLOCKED', 'GitHub mergeability is unknown or blocked.');
      ensure(await this.github.getBranchSha(run.baseBranch) === run.baseSha, 'STALE_BASE', `${run.baseBranch} changed. Start a new review.`);
      assertLock();
      // GitHub's atomic head comparison plus strict branch protection cover changes during the network gap.
      run = this.store.updateRun(run.id, { status: 'merging', stage: 'merging' });
      this.store.audit(actor.id, 'merge.requested', { runId, pr: number, headSha, baseSha: run.baseSha, reviewMode: run.reviewMode || 'live' });
      let result;
      try { result = await this.github.merge(number, headSha); }
      catch {
        this.store.updateRun(run.id, { status: 'merge_unknown', stage: 'manual_verification_required', error: 'GitHub did not confirm the merge outcome. Check the PR before further action.' });
        this.store.audit(actor.id, 'merge.unknown', { runId, pr: number });
        throw new DeskError('MERGE_UNKNOWN', 'GitHub did not confirm the merge outcome. Inspect the PR before retrying.', 502);
      }
      if (!result.merged) { this.store.updateRun(run.id, { status: 'failed', stage: 'merge_rejected', error: 'GitHub rejected the merge.' }); throw new DeskError('MERGE_REJECTED', 'GitHub rejected the merge. Refresh the PR.'); }
      this.store.updateRun(run.id, { status: 'merged', stage: 'merged', mergedBy: actor.id, mergeSha: result.sha });
      this.store.audit(actor.id, 'merge.completed', { runId, pr: number, sha: result.sha });
      return { merged: true, sha: result.sha, url: fresh.html_url };
    });
  }
  // Opens the release PR (staging into live). Releasing is then the same
  // test-and-merge flow as any other PR, against the live branch.
  async createRelease(actor) {
    this.requireReviewer(actor);
    ensure(setupBlockers(this.config).length === 0, 'SETUP_INCOMPLETE', 'Required integrations are not configured.', 503);
    const { stagingBranch: staging, liveBranch: live } = this.config;
    const open = (await this.github.listPulls()).find(pr => pr.base.ref === live && pr.head.ref === staging);
    if (open) return { created: false, number: open.number, url: open.html_url };
    const comparison = await this.github.compareBranches(live, staging);
    ensure((comparison.ahead_by ?? 0) > 0, 'NOTHING_TO_RELEASE', `${staging} has no changes that are not live yet.`);
    const titles = (comparison.commits || []).map(commit => String(commit.commit?.message || '').split('\n')[0]).filter(Boolean).slice(-20);
    const pr = await this.github.createPull({ title: `Release ${staging} to ${live}`, head: staging, base: live, body: `Release opened from Release Desk.\n\n${titles.map(title => `- ${title}`).join('\n')}` });
    this.store.audit(actor.id, 'release.opened', { pr: pr.number, aheadBy: comparison.ahead_by });
    return { created: true, number: pr.number, url: pr.html_url };
  }
  async reconcile(number, runId, actor) {
    this.requireReviewer(actor);
    ensure(typeof runId === 'string' && /^[a-f0-9-]{36}$/.test(runId), 'INVALID_REQUEST', 'A review run ID is required.', 400);
    return this.locked(number, async assertLock => {
      const run = this.store.getRun(runId);
      ensure(run && run.prNumber === number && run.status === 'merge_unknown', 'RUN_MISMATCH', 'Select the uncertain merge run for this PR.');
      ensure(Date.now() - Date.parse(run.updatedAt) >= 120_000, 'MERGE_SETTLING', 'Wait two minutes for the pending GitHub request to settle before checking its outcome.');
      const pr = await this.github.getPull(number);
      ensure(pr.base?.repo?.full_name === this.config.repository && pr.head?.repo?.full_name === this.config.repository && pr.base.ref === run.baseBranch, 'PR_SCOPE', 'Unexpected PR scope.');
      assertLock();
      let changes;
      if (pr.merged === true) {
        ensure(pr.head.sha === run.headSha, 'MERGE_REVISION_UNKNOWN', 'GitHub merged a different revision. Manual investigation is required.');
        changes = { status: 'merged', stage: 'outcome_reconciled', mergeSha: pr.merge_commit_sha, error: null };
      } else {
        changes = { status: pr.head.sha === run.headSha && pr.base.sha === run.baseSha ? 'failed' : 'stale', stage: 'outcome_reconciled', error: 'GitHub confirms this PR is not merged. A fresh full review is required before another merge attempt.' };
      }
      const result = this.store.updateRun(run.id, changes);
      this.store.audit(actor.id, 'merge.reconciled', { runId, pr: number, outcome: result.status });
      return result;
    });
  }
}
