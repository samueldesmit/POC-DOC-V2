// Loaded only by Vite development when ?fixture=1 is explicitly present.
// No Shopify or GitHub request is made by this fixture adapter.
const mode = new URLSearchParams(location.search).get('state') || 'ready';
const sha = '9c23e84a12d983b007118ae5c4f6d920b8140a7d';
const base = '4f8e20c19d8b4ab36e2a176dbe90274c6ad790bf';
const earlier = '47b91a7ef4061c8ec29f0ad7d4921b8d6efc2f06';
const startedAt = new Date(Date.now() - 12 * 60000).toISOString();
let testStarted = null;
let merged = false;
let mergedAt = null;
const historicalDate = new Date(Date.now() - 86400000).toISOString();
let reconciled = false;
const files = [
  { path: 'assets/product-stage.js', status: 'modified', additions: 12, deletions: 3 },
  { path: 'scripts/motion-runtime.test.mjs', status: 'modified', additions: 48, deletions: 2 },
  { path: 'sections/hero.liquid', status: 'modified', additions: 4, deletions: 1 },
].map(file => ({ ...file, url: `https://github.com/example-org/theme-repo/blob/${sha}/${file.path}` }));

function reviewRun() {
  const status = merged ? 'merged' : reconciled && !testStarted ? 'failed' : testStarted ? Date.now() - testStarted < (mode === 'demo' ? 12500 : 9000) ? 'running' : 'passed' : ({ ready: 'passed', readonly: 'passed', failed: 'failed', stale: 'passed', running: 'running', merge_unknown: 'merge_unknown' }[mode] || null);
  if (!status) return null;
  const pending = status === 'running';
  const demo = mode === 'demo';
  const elapsed = testStarted ? Date.now() - testStarted : 0;
  return { branches: { staging: 'staging', live: 'main' }, release: mode === 'empty' ? { aheadBy: 0, behindBy: 0, openPull: null } : { aheadBy: 3, behindBy: 0, openPull: null }, reviewMode: demo ? 'demo' : 'live', id: testStarted ? 'fixture-review-24' : 'fixture-review-23', prNumber: 12, headSha: mode === 'stale' && !testStarted ? earlier : sha, baseSha: base, status, stage: pending ? demo ? elapsed < 9500 ? 'demo_reviewing' : 'waiting_for_ci' : 'Claude agents are reviewing the current commit' : 'Review complete', createdAt: startedAt, updatedAt: testStarted ? new Date().toISOString() : startedAt,
    ci: { status: pending ? 'in_progress' : 'completed', conclusion: pending ? null : mode === 'failed' && !testStarted ? 'failure' : 'success', url: 'https://github.com/example-org/theme-repo/actions', runId: 'fixture-ci-23' },
    reviews: ['security', 'correctness', 'maintainability'].map((role, index) => ({ role, simulated: demo, status: demo ? !pending || elapsed >= [3500,6500,9500][index] ? 'completed' : elapsed >= [0,3500,6500][index] ? 'running' : 'pending' : pending && index > 0 ? 'running' : 'completed', verdict: demo && pending && elapsed < [3500,6500,9500][index] ? null : pending && !demo && index > 0 ? null : mode === 'failed' && role === 'correctness' && !testStarted ? 'request_changes' : 'approve', summary: demo ? 'Simulated reviewer result for the demonstration. No AI code review was performed.' : role === 'security' ? 'The change stays within media loading. No new permissions, credentials or external destinations.' : role === 'correctness' ? mode === 'failed' && !testStarted ? 'The empty-source error case still disables playback before the lazy URL is assigned.' : 'Playback resumes after source assignment. Loaded-source failures retain the poster fallback.' : 'The guard is local to the media lifecycle and the runtime regression covers both error targets.', findings: mode === 'failed' && role === 'correctness' && !testStarted ? [{ severity: 'high', path: 'assets/product-stage.js', line: 332, message: 'Ignore errors until a source URL is assigned; otherwise mobile playback can remain permanently disabled.' }] : [] })) };
}

function historicalRun() {
  return { id: 'fixture-history-review', prNumber: 9, headSha: earlier, baseSha: base, reviewMode: 'demo', status: 'passed', stage: 'finished', createdAt: historicalDate, updatedAt: historicalDate,
    ci: { status: 'completed', conclusion: 'success', url: 'https://github.com/example-org/theme-repo/actions', runId: 'fixture-history-ci' },
    reviews: ['security', 'correctness', 'maintainability'].map(role => ({ role, status: 'completed', simulated: true, verdict: 'approve', summary: 'Simulated reviewer result for the demonstration. No AI code review was performed.', findings: [] })) };
}

function dashboard() {
  const run = reviewRun();
  const allowed = run?.status === 'passed' && run?.headSha === sha;
  const currentPulls = [
    { number: 12, title: 'Keep the hero video playable after lazy loading', url: 'https://github.com/example-org/theme-repo/pull/12', author: 'webweit', draft: false, state: 'open', headSha: sha, baseSha: base, baseBranch: 'staging', stage: 'staging', updatedAt: startedAt, latestRun: run, mergeEligibility: { allowed: !!allowed, reasons: allowed ? [] : [mode === 'stale' ? 'The reviewed commit no longer matches the pull request head.' : 'Current-commit reviews and successful CI are required.'] } },
    { number: 11, title: 'Improve keyboard navigation in the product tour', url: 'https://github.com/example-org/theme-repo/pull/11', author: 'webweit', draft: false, state: 'open', headSha: earlier, baseSha: base, baseBranch: 'staging', stage: 'staging', updatedAt: startedAt, latestRun: null, mergeEligibility: { allowed: false, reasons: ['No test run exists for this commit.'] } },
    { number: 10, title: 'Refine journal card spacing', url: 'https://github.com/example-org/theme-repo/pull/10', author: 'webweit', draft: true, state: 'open', headSha: base, baseSha: base, baseBranch: 'staging', stage: 'staging', updatedAt: startedAt, latestRun: null, mergeEligibility: { allowed: false, reasons: ['Mark the pull request ready for review first.'] } },
  ].map(pull => ({ ...pull, status: 'open', merged: false, createdAt: startedAt, closedAt: null, mergedAt: null, mergedBy: null, mergeCommitSha: null }));
  const pulls = ['empty', 'history', 'setup'].includes(mode) ? [] : currentPulls.filter(pull => !merged || pull.number !== 12);
  const savedRun = historicalRun();
  const history = ['empty', 'setup'].includes(mode) ? [] : [
    ...(merged ? [{ ...currentPulls[0], state: 'closed', status: 'merged', merged: true, closedAt: mergedAt, mergedAt, mergedBy: 'release-desk-desk[bot]', mergeCommitSha: sha, mergeEligibility: { allowed: false, reasons: ['This pull request is already merged.'] } }] : []),
    { number: 9, title: 'Document the shared theme release workflow', url: 'https://github.com/example-org/theme-repo/pull/9', author: 'webweit', draft: false, state: 'closed', status: 'merged', merged: true, headSha: earlier, baseSha: sha, baseBranch: 'staging', stage: 'staging', createdAt: historicalDate, updatedAt: historicalDate, closedAt: historicalDate, mergedAt: historicalDate, mergedBy: 'release-desk-desk[bot]', mergeCommitSha: base, latestRun: savedRun, mergeEligibility: { allowed: false, reasons: ['This pull request is already merged.'] } },
    { number: 8, title: 'Explore an alternative homepage headline', url: 'https://github.com/example-org/theme-repo/pull/8', author: 'webweit', draft: false, state: 'closed', status: 'closed', merged: false, headSha: base, baseSha: sha, baseBranch: 'staging', stage: 'staging', createdAt: historicalDate, updatedAt: historicalDate, closedAt: historicalDate, mergedAt: null, mergedBy: null, mergeCommitSha: null, latestRun: null, mergeEligibility: { allowed: false, reasons: ['This pull request was closed.'] } },
  ];
  return { reviewMode: mode === 'demo' ? 'demo' : 'live', shop: 'example-store.myshopify.com', actor: { id: 'development-fixture', canMutate: mode !== 'readonly' }, repository: 'example-org/theme-repo', setup: { ready: mode !== 'setup', blockers: mode === 'setup' ? [{ code: 'GITHUB_AUTH_MISSING', message: 'Connect the GitHub App to example-org/theme-repo.' }, { code: 'ANTHROPIC_KEY_MISSING', message: 'Add an Anthropic API key for live review mode, or configure demo mode.' }] : [] }, pulls, history, historyError: null, runs: [...(run ? [run] : []), ...(history.length ? [savedRun] : [])], notifications: mode === 'empty' ? [] : [{ id: 'fixture-notification-2', title: merged ? 'Hero playback fix merged' : run?.status === 'passed' ? 'Review completed for the hero playback fix' : 'New pull request opened', prNumber: 12, createdAt: startedAt }, { id: 'fixture-notification-1', title: 'Release workflow documentation merged', prNumber: 9, createdAt: historicalDate }], deployment: { description: 'Merging updates main. Store deployment follows the repository workflow; this app does not publish themes directly.' }, updatedAt: new Date().toISOString() };
}

export async function fixtureRequest(path, { method, body, signal } = {}) {
  await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 220); if (signal?.aborted) { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); } else signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true }); });
  if (mode === 'error') throw new Error('The development fixture is simulating an unavailable release service.');
  if (path === '/api/dashboard') return dashboard();
  if (path.startsWith('/api/runs/')) return { run: path.endsWith('fixture-history-review') ? historicalRun() : reviewRun() };
  const number = Number(path.match(/\/pulls\/(\d+)/)?.[1]);
  if (method === 'POST' && path.endsWith('/test')) { testStarted = Date.now(); return { run: reviewRun() }; }
  if (method === 'POST' && path.endsWith('/reconcile')) { reconciled = true; return { run: reviewRun() }; }
  if (path === '/api/connections' && method === 'GET') return { connections: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Fixture user', email: 'fixture@example.com', createdAt: new Date().toISOString(), lastUsedAt: null }] };
  if (path === '/api/connections' && method === 'POST') return { connection: { id: '00000000-0000-4000-8000-000000000002', name: body?.name || 'Fixture user' }, url: 'https://desk.example/mcp/rdc_fixture-link-not-real' };
  if (path.startsWith('/api/connections/') && method === 'DELETE') return { revoked: true };
  if (method === 'POST' && path === '/api/release') return { created: true, number: 12, url: 'https://github.com/example-org/theme-repo/pull/12' };
  if (method === 'POST' && path.endsWith('/merge')) { merged = true; mergedAt = new Date().toISOString(); return { merged: true, sha, url: 'https://github.com/example-org/theme-repo/pull/12' }; }
  const data = dashboard();
  const pull = [...data.pulls, ...data.history].find(item => item.number === number);
  return { pull, filesUnavailableReason: null, files: number === 9 ? [{ path: 'docs/release-workflow.md', status: 'added', additions: 18, deletions: 0 }] : number === 12 ? files : [{ path: number === 11 ? 'assets/product-stage.js' : 'theme/assets/vw-section-presets.css', status: 'modified', additions: 9, deletions: 3 }], runs: number === 9 ? [historicalRun()] : number === 12 && reviewRun() ? [reviewRun(), { ...reviewRun(), id: 'fixture-review-22', headSha: earlier, status: 'stale', createdAt: new Date(Date.now() - 86400000).toISOString() }] : [] };
}
