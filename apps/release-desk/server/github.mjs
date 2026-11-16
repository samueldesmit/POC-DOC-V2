import { createAppAuth } from '@octokit/auth-app';
import { CHECK_NAME, WORKFLOW, releaseTargets } from './config.mjs';
import { DeskError, ensure, isSha } from './errors.mjs';

const TRANSIENT_READ_STATUSES = new Set([429, 502, 503, 504]);
const READ_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const INLINE_RETRY_LIMIT_MS = 2_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function readUnavailable(retryAfterMs = 0) {
  const error = new DeskError('GITHUB_READ_UNAVAILABLE', 'GitHub is temporarily unavailable. Please try again shortly.', 503);
  error.retryAfterMs = retryAfterMs;
  return error;
}
function retryDelay(response, now) {
  const retryAfter = response.headers.get('retry-after');
  let delay = 0;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - now);
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    if (Number.isFinite(reset)) delay = Math.max(delay || 0, reset - now);
  }
  // GitHub asks clients to wait at least a minute when a rate limit has no reset header.
  return Number.isFinite(delay) && delay > 0 ? delay : response.status === 429 ? 60_000 : 0;
}

export class GitHub {
  constructor(config, { fetchImpl = fetch, sleepImpl = sleep, now = Date.now } = {}) {
    this.config = config; this.fetch = fetchImpl; this.sleep = sleepImpl; this.now = now;
    if (config.githubAppId && config.githubPrivateKey && config.githubInstallationId) this.auth = createAppAuth({ appId: config.githubAppId, privateKey: config.githubPrivateKey, installationId: config.githubInstallationId });
  }
  async request(method, route, body, { accept = 'application/vnd.github+json', maxBytes = 2_000_000 } = {}) {
    ensure(route.startsWith(`/repos/${this.config.repository}/`), 'GITHUB_ROUTE', 'Repository access is restricted.', 500);
    let authTimer;
    let token;
    try {
      token = this.auth ? (await Promise.race([
        this.auth({ type: 'installation' }),
        new Promise((_, reject) => { authTimer = setTimeout(() => reject(new DeskError('GITHUB_AUTH_TIMEOUT', 'GitHub authentication timed out.', 502)), 20_000); authTimer.unref(); }),
      ])).token : this.config.githubToken;
    } finally { clearTimeout(authTimer); }
    ensure(token, 'GITHUB_UNCONFIGURED', 'GitHub authentication is not configured.', 503);
    const isRead = method === 'GET';
    // One total timeout across attempts: retries must not triple a request's time budget.
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const options = { method, headers: { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'Release-Desk' }, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' };
    for (let attempt = 0; attempt < (isRead ? READ_ATTEMPTS : 1); attempt++) {
      let response, text;
      try {
        response = await this.fetch(`https://api.github.com${route}`, options);
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (isRead && TRANSIENT_READ_STATUSES.has(response.status)) throw readUnavailable(retryDelay(response, this.now()));
          const rejected = new DeskError('GITHUB_ERROR', `GitHub rejected the operation (HTTP ${response.status}).`, response.status === 404 ? 404 : 502);
          rejected.httpStatus = response.status;
          throw rejected;
        }
        if (response.status === 204) return null;
        let bytes = 0; const chunks = [];
        for await (const chunk of response.body) { bytes += chunk.length; ensure(bytes <= maxBytes, 'GITHUB_RESPONSE_LIMIT', 'GitHub response exceeded the review limit.'); chunks.push(chunk); }
        text = Buffer.concat(chunks).toString('utf8');
      } catch (error) {
        // Only transport failures and the explicit transient GET statuses are retryable.
        // Never replay dispatch/check/merge mutations, response limits or validation failures.
        if (!isRead || error instanceof DeskError && error.code !== 'GITHUB_READ_UNAVAILABLE') throw error;
        const unavailable = error instanceof DeskError ? error : readUnavailable();
        const delay = Math.max(500 * 2 ** attempt, unavailable.retryAfterMs);
        if (attempt === READ_ATTEMPTS - 1 || signal.aborted || delay > INLINE_RETRY_LIMIT_MS) throw unavailable;
        await this.sleep(delay);
        if (signal.aborted) throw unavailable;
        continue;
      }
      // Malformed successful responses are validation failures, not a reason to retry.
      return accept.includes('diff') ? text : JSON.parse(text);
    }
  }
  route(suffix) { return `/repos/${this.config.repository}/${suffix}`; }
  getPull(number) { return this.request('GET', this.route(`pulls/${number}`)); }
  async listPulls() {
    const targets = releaseTargets(this.config);
    return (await this.request('GET', this.route('pulls?state=open&per_page=100&sort=updated&direction=desc'))).filter(pr => targets.includes(pr.base?.ref));
  }
  async listHistory() {
    const targets = releaseTargets(this.config);
    return (await this.request('GET', this.route('pulls?state=closed&per_page=100&sort=updated&direction=desc'))).filter(pr => targets.includes(pr.base?.ref)).slice(0, 50);
  }
  async getBranchSha(branch) {
    ensure(releaseTargets(this.config).includes(branch), 'BRANCH_SCOPE', 'Only the staging and live branches are tracked.', 500);
    return (await this.request('GET', this.route(`git/ref/heads/${branch}`))).object.sha;
  }
  async compareBranches(base, head) { return this.request('GET', this.route(`compare/${base}...${head}?per_page=1`)); }
  createPull({ title, head, base, body }) { return this.request('POST', this.route('pulls'), { title, head, base, body, maintainer_can_modify: false }); }
  async files(number, expectedCount = null) {
    if (expectedCount !== null) ensure(expectedCount <= this.config.maxFiles, 'DIFF_LIMIT', 'The PR exceeds the supported review file limit.');
    const files = [];
    for (let page = 1; page <= 31; page++) {
      const batch = await this.request('GET', this.route(`pulls/${number}/files?per_page=100&page=${page}`)); files.push(...batch);
      ensure(files.length <= this.config.maxFiles, 'DIFF_LIMIT', 'The PR exceeds the supported review file limit.');
      if (batch.length < 100) break;
    }
    if (expectedCount !== null) ensure(files.length === expectedCount, 'DIFF_INCOMPLETE', 'GitHub did not return every changed file.');
    return files;
  }
  async immutableFiles(baseSha, headSha) {
    ensure(isSha(baseSha) && isSha(headSha), 'INVALID_SHA', 'Immutable diff revisions are required.');
    const comparison = await this.request('GET', this.route(`compare/${baseSha}...${headSha}?per_page=100`));
    ensure(comparison.base_commit?.sha === baseSha && comparison.commits?.at(-1)?.sha === headSha && comparison.total_commits === comparison.commits.length, 'DIFF_INCOMPLETE', 'The immutable comparison is incomplete or exceeds 100 commits.');
    // GitHub includes at most 300 files on this first page. Our smaller bound fails closed before that truncation limit.
    ensure(Array.isArray(comparison.files) && comparison.files.length > 0 && comparison.files.length <= this.config.maxFiles, 'DIFF_LIMIT', 'The immutable diff exceeds the supported file limit.');
    return comparison.files;
  }
  async protection(branch) {
    const none = { ready: false, strict: false, appPinned: false, adminsEnforced: false, source: null };
    try { ensure(releaseTargets(this.config).includes(branch), 'BRANCH_SCOPE', 'Only the staging and live branches are tracked.', 500); } catch { return none; }
    const appId = Number(this.config.githubAppId);
    // Repository rulesets: the required Release Desk check, pinned to this app, strict.
    // Rulesets apply to administrators unless they are listed as bypass actors.
    try {
      const rules = await this.request('GET', this.route(`rules/branches/${encodeURIComponent(branch)}`));
      const check = (Array.isArray(rules) ? rules : []).find(rule => rule.type === 'required_status_checks' && rule.parameters?.required_status_checks?.some(c => c.context === CHECK_NAME && Number(c.integration_id) === appId && appId > 0));
      if (check) {
        const strict = check.parameters.strict_required_status_checks_policy === true;
        return { ready: strict, strict, appPinned: true, adminsEnforced: true, source: 'ruleset' };
      }
    } catch { /* fall through to classic protection */ }
    try {
      const p = await this.request('GET', this.route(`branches/${branch}/protection`));
      const checks = p.required_status_checks;
      const pinned = checks?.checks?.some(c => c.context === CHECK_NAME && Number(c.app_id) === appId && appId > 0);
      return { ready: checks?.strict === true && pinned && p.enforce_admins?.enabled === true, strict: checks?.strict === true, appPinned: Boolean(pinned), adminsEnforced: p.enforce_admins?.enabled === true, source: 'branch_protection' };
    } catch { return none; }
  }
  dispatch(run) { return this.request('POST', this.route('actions/workflows/review-pr.yml/dispatches'), { ref: run.baseBranch, inputs: { pr: String(run.prNumber), head_sha: run.headSha, base_sha: run.baseSha, run_id: run.id } }); }
  async findWorkflowRun(run) {
    const result = await this.request('GET', this.route(`actions/workflows/review-pr.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(run.baseBranch)}&per_page=100`));
    const matches = result.workflow_runs.filter(candidate => candidate.display_title === `Release Desk ${run.id}`);
    ensure(matches.length <= 1, 'CI_AMBIGUOUS', 'Multiple workflow runs matched this review.');
    if (!matches.length) return null;
    return this.workflowEvidence(run, matches[0].id);
  }
  async workflowEvidence(run, id) {
    const result = await this.request('GET', this.route(`actions/runs/${id}`));
    validateWorkflow(run, result, this.config);
    let jobs = [];
    if (result.status === 'completed') {
      const data = await this.request('GET', this.route(`actions/runs/${id}/attempts/${result.run_attempt}/jobs?per_page=100`));
      jobs = data.jobs;
      ensure(data.total_count === jobs.length, 'CI_INCOMPLETE', 'Workflow job results are incomplete.');
      for (const name of this.config.expectedJobs) ensure(jobs.filter(job => job.name === name && job.status === 'completed' && job.conclusion === 'success').length === 1, 'CI_FAILED', `Required job ${name} did not pass.`);
      ensure(jobs.every(job => job.status === 'completed' && job.conclusion === 'success'), 'CI_FAILED', 'A workflow job did not pass.');
    }
    return { status: result.status, conclusion: result.conclusion, url: result.html_url, runId: result.id, attempt: result.run_attempt, headSha: result.head_sha, jobs: jobs.map(job => ({ name: job.name, conclusion: job.conclusion })) };
  }
  async startCheck(run) {
    const demo = run.reviewMode === 'demo';
    const check = await this.request('POST', this.route('check-runs'), { name: CHECK_NAME, head_sha: run.headSha, status: 'in_progress', external_id: run.id, started_at: new Date().toISOString(), output: { title: demo ? 'Real CI + simulated AI in progress' : 'Review in progress', summary: `Review ${run.id}; base ${run.baseSha}.\nReviewer mode: ${demo ? 'DEMO — simulated AI; no AI code review is performed.' : 'live AI review'}` } });
    return check.id;
  }
  finishCheck(run, success, message) {
    if (!run.checkId) return Promise.resolve();
    const demo = run.reviewMode === 'demo';
    return this.request('PATCH', this.route(`check-runs/${run.checkId}`), { status: 'completed', conclusion: success ? 'success' : 'failure', completed_at: new Date().toISOString(), output: { title: success ? (demo ? 'Real CI passed · simulated AI demo' : 'All review gates passed') : (demo ? 'Not approved · simulated AI demo' : 'Review not approved'), summary: `${message}\nReviewer mode: ${demo ? 'DEMO — simulated AI; no AI code review was performed.' : 'live AI review'}\nHead: ${run.headSha}\nBase: ${run.baseSha}\nRun: ${run.id}` } });
  }
  async verifyCheck(run) {
    const check = await this.request('GET', this.route(`check-runs/${run.checkId}`));
    ensure(check.name === CHECK_NAME && check.external_id === run.id && check.head_sha === run.headSha && check.conclusion === 'success' && check.status === 'completed' && Number(check.app?.id) === Number(this.config.githubAppId), 'CHECK_INVALID', 'The GitHub review check is missing or no longer successful.');
  }
  pullCommits(number) { return this.request('GET', this.route(`pulls/${number}/commits?per_page=100`)); }
  // --- Claude connector: read the theme and write only to claude/ change branches ---
  async tree(ref) {
    const sha = isSha(ref) ? ref : await this.branchSha(ref);
    const tree = await this.request('GET', this.route(`git/trees/${sha}?recursive=1`), undefined, { maxBytes: 8_000_000 });
    ensure(!tree.truncated && Array.isArray(tree.tree), 'TREE_INCOMPLETE', 'The repository tree is too large to list.', 422);
    return tree.tree.filter(entry => entry.type === 'blob').map(entry => ({ path: entry.path, size: entry.size, sha: entry.sha }));
  }
  async readFile(path, ref) {
    const blob = await this.request('GET', this.route(`contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`), undefined, { maxBytes: 4_000_000 });
    ensure(blob && blob.type === 'file' && blob.encoding === 'base64', 'NOT_A_FILE', 'That path is not a file.', 404);
    return { content: Buffer.from(blob.content, 'base64'), sha: blob.sha, size: blob.size };
  }
  async branchSha(branch) { return (await this.request('GET', this.route(`git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`))).object.sha; }
  createBranch(branch, sha) {
    ensure(/^claude\/[a-z0-9-]{3,80}$/.test(branch), 'BRANCH_SCOPE', 'Connector branches must be claude/ branches.', 500);
    return this.request('POST', this.route('git/refs'), { ref: `refs/heads/${branch}`, sha });
  }
  // One commit for a set of file changes, authored by the person who asked for it.
  async commitFiles(branch, { message, files, author }) {
    ensure(/^claude\/[a-z0-9-]{3,80}$/.test(branch), 'BRANCH_SCOPE', 'Connector branches must be claude/ branches.', 500);
    const parent = await this.branchSha(branch);
    const parentCommit = await this.request('GET', this.route(`git/commits/${parent}`));
    const tree = [];
    for (const file of files) {
      if (file.delete) { tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const blob = await this.request('POST', this.route('git/blobs'), { content: Buffer.from(file.content, 'utf8').toString('base64'), encoding: 'base64' });
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await this.request('POST', this.route('git/trees'), { base_tree: parentCommit.tree.sha, tree });
    const commit = await this.request('POST', this.route('git/commits'), { message, tree: newTree.sha, parents: [parent], author: { ...author, date: new Date().toISOString() } });
    // Non-forced: fails if the branch moved meanwhile, so nothing is overwritten.
    await this.request('PATCH', this.route(`git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`), { sha: commit.sha, force: false });
    return commit.sha;
  }
  // Bring a change branch up to date with its target (a merge commit on the change branch).
  updateBranch(number, expectedHeadSha) { return this.request('PUT', this.route(`pulls/${number}/update-branch`), { expected_head_sha: expectedHeadSha }); }
  // Merge one tracked branch into another (used only to bring staging up to date with live).
  mergeBranches(base, head, message) {
    ensure(base === this.config.stagingBranch && head === this.config.liveBranch, 'BRANCH_SCOPE', 'Only live can be merged into staging directly.', 500);
    return this.request('POST', this.route('merges'), { base, head, commit_message: message });
  }
  merge(number, sha) { return this.request('PUT', this.route(`pulls/${number}/merge`), { sha, merge_method: 'squash' }); }
}

export function validateWorkflow(run, workflow, config) {
  ensure(workflow.display_title === `Release Desk ${run.id}` && workflow.event === 'workflow_dispatch' && workflow.head_branch === run.baseBranch && workflow.head_sha === run.baseSha && workflow.path === WORKFLOW && workflow.repository?.full_name === config.repository, 'CI_CORRELATION', 'The workflow run is not the trusted run for this review.');
  ensure(Date.parse(workflow.created_at) >= Date.parse(run.createdAt) - 5_000, 'CI_CORRELATION', 'The workflow predates this review.');
}

export function validatePull(pr, config, expectedHead, expectedBase) {
  ensure(pr.state === 'open' && !pr.merged && !pr.draft, 'PR_INELIGIBLE', 'The PR must be open and ready for review.');
  ensure(releaseTargets(config).includes(pr.base?.ref) && pr.base.repo?.full_name === config.repository && pr.head?.repo?.full_name === config.repository, 'PR_SCOPE', `Only same-repository PRs targeting ${config.stagingBranch} or ${config.liveBranch} are supported.`);
  // Nothing reaches live without passing through staging first.
  ensure(pr.base.ref !== config.liveBranch || pr.head.ref === config.stagingBranch, 'PR_SCOPE', `Only ${config.stagingBranch} can be released to ${config.liveBranch}.`);
  if (expectedHead) ensure(pr.head.sha === expectedHead, 'STALE_HEAD', 'The PR changed. Start a new review for its current commit.');
  if (expectedBase) ensure(pr.base.sha === expectedBase, 'STALE_BASE', `${pr.base.ref} changed. Start a new review against the current base.`);
}
