import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, ROLES } from '../config.mjs';
import { Store } from '../store.mjs';
import { Service } from '../service.mjs';
import { Flow } from '../flow.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const actor = { id: '42', canMutate: true };
function config() { return { ...configuration({ GITHUB_REPOSITORY: 'example-org/theme-repo', SHOP_DOMAIN: 'example-store.myshopify.com', SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: 's', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'x', GITHUB_INSTALLATION_ID: '456', GITHUB_WEBHOOK_SECRET: 'w', CLAUDE_REVIEW_MODE: 'demo' }) }; }
const pull = (overrides = {}) => ({ number: 7, state: 'open', merged: false, draft: false, html_url: 'u', title: 't', user: { login: 'x' }, head: { sha: head, ref: 'claude/hero-abc123', repo: { full_name: 'example-org/theme-repo' } }, base: { sha: base, ref: 'staging', repo: { full_name: 'example-org/theme-repo' } }, mergeable: true, mergeable_state: 'clean', ...overrides });
function harness(t, pr = pull()) {
  const cfg = config(), store = new Store(':memory:');
  t.after(() => store.close());
  const github = {
    pr, calls: [],
    async getPull() { return structuredClone(this.pr); },
    async getBranchSha(branch) { return branch === 'staging' ? this.pr.base.sha : base; },
    async protection() { return { ready: true }; },
    async listPulls() { return [structuredClone(this.pr)]; },
    async workflowEvidence() { return { status: 'completed', conclusion: 'success', runId: 12, attempt: 1 }; },
    async verifyCheck() {},
    async merge(number, sha) { this.calls.push(['merge', number, sha]); return { merged: true, sha: merged }; },
    async updateBranch(number, sha) { this.calls.push(['updateBranch', number, sha]); },
    async mergeBranches(b, h) { this.calls.push(['mergeBranches', b, h]); if (this.syncConflict) { const error = new Error('conflict'); error.httpStatus = 409; throw error; } },
    async compareBranches() { return { ahead_by: 1, commits: [] }; },
    async createPull(input) { this.calls.push(['createPull', input.head, input.base]); this.pr = pull({ number: 9, head: { ...pr.head, ref: 'staging' }, base: { ...pr.base, ref: 'main' } }); return { number: 9, html_url: 'u9' }; },
  };
  const service = new Service({ config: cfg, store, github });
  const scheduled = [];
  const flow = new Flow({ config: cfg, store, github, service, schedule: fn => scheduled.push(fn) });
  service.flow = flow;
  const pass = number => { const run = store.listRuns(number, 1)[0]; return store.updateRun(run.id, { status: 'passed', checkId: 1, reviews: ROLES.map(role => ({ role, status: 'completed', simulated: true, verdict: 'approve', findings: [] })), ci: { status: 'completed', conclusion: 'success', runId: 12, attempt: 1 } }); };
  return { store, github, flow, service, scheduled, pass };
}

test('one click: the change is checked automatically, then merged into staging once the check passes', async t => {
  const { store, github, flow, pass } = harness(t);
  await flow.publish(7, actor);
  assert.equal(store.listRuns(7).length, 1, 'a check was started');
  assert.equal(flow.intent(7).kind, 'staging');
  assert.equal(github.calls.filter(call => call[0] === 'merge').length, 0, 'nothing merges before the check passes');
  pass(7);
  await flow.progress(7);
  assert.deepEqual(github.calls.find(call => call[0] === 'merge'), ['merge', 7, head]);
  assert.equal(flow.intent(7), null);
});

test('without a request to publish, a passing check never merges', async t => {
  const { github, flow, pass } = harness(t);
  await flow.progress(7);
  pass(7);
  await flow.progress(7);
  assert.equal(github.calls.filter(call => call[0] === 'merge').length, 0);
});

test('a failed check stops the change and explains what to do', async t => {
  const { store, github, flow } = harness(t);
  await flow.publish(7, actor);
  store.updateRun(store.listRuns(7, 1)[0].id, { status: 'failed' });
  await flow.progress(7);
  assert.match(flow.intent(7).problem, /Ask Claude to fix it/);
  assert.equal(github.calls.filter(call => call[0] === 'merge').length, 0);
});

test('a change that is behind staging is brought up to date instead of merged', async t => {
  const { github, flow } = harness(t, pull({ mergeable_state: 'behind' }));
  await flow.publish(7, actor);
  assert.deepEqual(github.calls, [['updateBranch', 7, head]]);
});

test('a conflicting change is not touched and asks for Strix', async t => {
  const { github, flow } = harness(t, pull({ mergeable_state: 'dirty' }));
  await flow.publish(7, actor);
  assert.equal(github.calls.length, 0);
  assert.match(flow.intent(7).problem, /Strix/);
});

test('going live first brings staging up to date with live, then opens and checks one release', async t => {
  const { github, flow, store } = harness(t);
  await flow.goLive(actor);
  assert.deepEqual(github.calls.slice(0, 2), [['mergeBranches', 'staging', 'main'], ['createPull', 'staging', 'main']]);
  assert.equal(flow.intent(9).kind, 'live');
  assert.equal(store.listRuns(9).length, 1);
});

test('going live stops with a clear message when live and staging conflict', async t => {
  const { github, flow } = harness(t);
  github.syncConflict = true;
  await assert.rejects(flow.goLive(actor), { code: 'SYNC_CONFLICT' });
  assert.ok(!github.calls.some(call => call[0] === 'createPull'));
});

test('read-only users cannot publish or go live', async t => {
  const { flow } = harness(t);
  await assert.rejects(flow.publish(7, { id: '43', canMutate: false }), { code: 'FORBIDDEN' });
  await assert.rejects(flow.goLive({ id: '43', canMutate: false }), { code: 'FORBIDDEN' });
});

test('GitHub events schedule progress; a finished check moves its PR on', async t => {
  const { flow, scheduled } = harness(t);
  flow.onWebhook('workflow_run', { action: 'completed', workflow_run: { pull_requests: [{ number: 7 }] } });
  flow.onWebhook('pull_request', { action: 'synchronize', number: 7 });
  flow.onRunFinished({ prNumber: 7 });
  assert.equal(scheduled.length, 3);
});
