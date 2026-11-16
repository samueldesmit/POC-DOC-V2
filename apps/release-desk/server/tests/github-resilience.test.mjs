import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../github.mjs';
import { Worker } from '../worker.mjs';
import { Store } from '../store.mjs';
import { configuration, ROLES } from '../config.mjs';
import { DeskError } from '../errors.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const config = () => ({ ...configuration({ GITHUB_REPOSITORY: 'example-org/theme-repo', SHOP_DOMAIN: 'example-store.myshopify.com', }), githubToken: 'fixture-token' });
const unavailable = (retryAfterMs = 0) => Object.assign(new DeskError('GITHUB_READ_UNAVAILABLE', 'GitHub is temporarily unavailable.', 503), { retryAfterMs });
const approvals = () => ROLES.map(role => ({ role, status: 'completed', verdict: 'approve', summary: 'Fixture approval.', findings: [] }));
function pull(number = 7) {
  return { number, state: 'open', merged: false, draft: false, head: { sha: head, repo: { full_name: config().repository } }, base: { ref: 'staging', sha: base, repo: { full_name: config().repository } } };
}
function client(responses, options = {}) {
  const calls = [], sleeps = [];
  const github = new GitHub(config(), { ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    const result = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result() : new Response(JSON.stringify(result.body ?? { ok: true }), { status: result.status, headers: result.headers });
  }, sleepImpl: async delay => { sleeps.push(delay); } });
  return { github, calls, sleeps, read: () => github.getPull(7) };
}
function workerContext(t) {
  const cfg = config(), store = new Store(':memory:');
  t.after(() => store.close());
  const calls = { pull: 0, workflow: 0, dispatch: 0, review: 0, checks: [] };
  const github = {
    getPull: async number => { calls.pull++; return pull(number); }, getBranchSha: async () => base,
    startCheck: async () => 456, dispatch: async () => { calls.dispatch++; },
    workflowEvidence: async () => { calls.workflow++; return { status: 'completed', conclusion: 'success', runId: 123, attempt: 1 }; },
    findWorkflowRun: async function() { return this.workflowEvidence(); },
    finishCheck: async (run, success) => { calls.checks.push({ id: run.id, success }); },
  };
  const reviews = { run: async () => { calls.review++; return approvals(); } };
  const run = store.enqueue(pull(), { id: '42' }, cfg);
  store.updateRun(run.id, { status: 'running', checkId: 456, dispatchAt: new Date().toISOString(), reviews: approvals(), ci: { status: 'in_progress', conclusion: null, runId: 123, url: 'https://github.com/example/run/123' } });
  const ctx = { config: cfg, store, github, reviews, calls, run };
  return { ...ctx, worker: new Worker(ctx) };
}
function expireCooldown(ctx, id = ctx.run.id) {
  ctx.store.db.prepare('UPDATE runs SET lease_until=0 WHERE id=?').run(id);
  ctx.store.updateRun(id, { githubRetryAt: new Date(Date.now() - 1).toISOString() });
}

test('GitHub GET retries two transient responses within one timeout budget, then returns the result', async () => {
  const ctx = client([{ status: 503 }, { status: 502 }, { status: 200, body: { number: 7 } }]);
  assert.deepEqual(await ctx.read(), { number: 7 });
  assert.equal(ctx.calls.length, 3); assert.deepEqual(ctx.sleeps, [500, 1000]);
  assert.equal(new Set(ctx.calls.map(call => call.init.signal)).size, 1);
  assert.equal(new Set(ctx.calls.map(call => call.url)).size, 1);
});

test('GitHub transient HTTP and network GET failures exhaust at three attempts with a safe typed error', async () => {
  for (const response of [{ status: 502 }, { status: 503 }, { status: 504 }, new TypeError('fetch failed: private transport detail')]) {
    const ctx = client([response]);
    await assert.rejects(ctx.read(), error => error.code === 'GITHUB_READ_UNAVAILABLE' && error.status === 503 && !error.message.includes('private'));
    assert.equal(ctx.calls.length, 3); assert.deepEqual(ctx.sleeps, [500, 1000]);
  }
});

test('GitHub retries a failed response stream but never retries malformed JSON or an oversized response', async () => {
  const failedStream = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection terminated')); } }));
  const ctx = client([failedStream, { status: 200 }]);
  assert.deepEqual(await ctx.read(), { ok: true }); assert.equal(ctx.calls.length, 2);
  const malformed = client([() => new Response('{broken')]);
  await assert.rejects(malformed.read(), SyntaxError); assert.equal(malformed.calls.length, 1);
  const oversized = client([{ status: 200, body: { tooLarge: 'x'.repeat(100) } }]);
  await assert.rejects(oversized.github.request('GET', oversized.github.route('pulls/7'), undefined, { maxBytes: 10 }), { code: 'GITHUB_RESPONSE_LIMIT' });
  assert.equal(oversized.calls.length, 1);
});

test('GitHub permanent read errors and every mutation failure are attempted exactly once', async () => {
  for (const status of [401, 403, 404, 422, 500]) {
    const ctx = client([{ status }]);
    await assert.rejects(ctx.read(), { code: 'GITHUB_ERROR' }); assert.equal(ctx.calls.length, 1);
  }
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    for (const response of [{ status: 503 }, { status: 429 }, new TypeError('fetch failed')]) {
      const ctx = client([response]);
      await assert.rejects(ctx.github.request(method, ctx.github.route('fixture'), { fixture: true }), error => error.code !== 'GITHUB_READ_UNAVAILABLE');
      assert.equal(ctx.calls.length, 1); assert.deepEqual(ctx.sleeps, []);
    }
  }
});

test('GitHub respects rate-limit resets and long Retry-After by deferring without an inline request burst', async () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const cases = [
    { status: 429, headers: {}, delay: 60_000 },
    { status: 503, headers: { 'retry-after': '90' }, delay: 90_000 },
    { status: 429, headers: { 'retry-after': new Date(now + 120_000).toUTCString() }, delay: 120_000 },
    { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 180_000) / 1000) }, delay: 180_000 },
  ];
  for (const fixture of cases) {
    const ctx = client([fixture], { now: () => now });
    await assert.rejects(ctx.read(), error => error.code === 'GITHUB_READ_UNAVAILABLE' && error.retryAfterMs === fixture.delay);
    assert.equal(ctx.calls.length, 1); assert.deepEqual(ctx.sleeps, []);
  }
  const brief = client([{ status: 503, headers: { 'retry-after': '1' } }, { status: 200 }]);
  await brief.read(); assert.deepEqual(brief.sleeps, [1000]);
});

test('Worker preserves CI and reviews through an outage, persists cooldown and resumes without redispatch', async t => {
  const ctx = workerContext(t), before = ctx.store.getRun(ctx.run.id);
  const originalEvidence = ctx.github.workflowEvidence;
  ctx.github.workflowEvidence = async () => { ctx.calls.workflow++; throw unavailable(); };
  const started = Date.now(); await ctx.worker.tick();
  const waiting = ctx.store.getRun(ctx.run.id);
  assert.equal(waiting.status, 'running'); assert.equal(waiting.stage, 'waiting_for_github'); assert.equal(waiting.error, null);
  assert.deepEqual(waiting.ci, before.ci); assert.deepEqual(waiting.reviews, before.reviews);
  assert.equal(waiting.checkId, before.checkId); assert.equal(waiting.dispatchAt, before.dispatchAt); assert.equal(waiting.createdAt, before.createdAt);
  assert.equal(waiting.githubReadFailures, 1); assert.ok(Date.parse(waiting.githubRetryAt) >= started + 15_000);
  const replacement = new Worker(ctx);
  await ctx.worker.tick(); await replacement.tick();
  assert.equal(ctx.calls.workflow, 1); assert.equal(ctx.calls.pull, 1); assert.deepEqual(ctx.calls.checks, []);
  expireCooldown(ctx); ctx.github.workflowEvidence = originalEvidence;
  await replacement.tick();
  const completed = ctx.store.getRun(ctx.run.id);
  assert.equal(completed.status, 'passed'); assert.equal(completed.githubReadFailures, 0); assert.equal(completed.githubRetryAt, null);
  assert.equal(ctx.calls.dispatch, 0); assert.equal(ctx.calls.review, 0); assert.deepEqual(ctx.calls.checks, [{ id: ctx.run.id, success: true }]);
});

test('Worker escalates persisted outage cooldown to 15/30/60 seconds while leaving other jobs claimable', async t => {
  const ctx = workerContext(t);
  ctx.github.workflowEvidence = async () => { throw unavailable(); };
  for (const [index, delay] of [15_000, 30_000, 60_000, 60_000].entries()) {
    if (index) expireCooldown(ctx);
    const started = Date.now(); await new Worker(ctx).tick();
    const waiting = ctx.store.getRun(ctx.run.id);
    assert.equal(waiting.githubReadFailures, index + 1);
    assert.ok(Date.parse(waiting.githubRetryAt) >= started + delay);
    assert.ok(Date.parse(waiting.githubRetryAt) <= Date.now() + delay);
  }
  const second = ctx.store.enqueue(pull(8), { id: '42' }, ctx.config);
  const claimed = ctx.store.claim('another-worker');
  assert.equal(claimed.id, second.id); assert.deepEqual(ctx.calls.checks, []);
});

test('Worker honors Retry-After and caps the cooldown at the original review deadline', async t => {
  const ctx = workerContext(t);
  ctx.github.getPull = async () => { throw unavailable(120_000); };
  const started = Date.now(); await ctx.worker.tick();
  assert.ok(Date.parse(ctx.store.getRun(ctx.run.id).githubRetryAt) >= started + 120_000);
  expireCooldown(ctx);
  const createdAt = new Date(Date.now() - ctx.config.maxRunMs + 5_000).toISOString();
  ctx.store.updateRun(ctx.run.id, { createdAt });
  await ctx.worker.tick();
  const waiting = ctx.store.getRun(ctx.run.id);
  assert.equal(waiting.status, 'running');
  assert.ok(Date.parse(waiting.githubRetryAt) <= Date.parse(createdAt) + ctx.config.maxRunMs + 5);
  ctx.store.updateRun(ctx.run.id, { createdAt: new Date(Date.now() - ctx.config.maxRunMs - 1).toISOString() });
  expireCooldown(ctx); await ctx.worker.tick();
  const expired = ctx.store.getRun(ctx.run.id);
  assert.equal(expired.status, 'failed'); assert.match(expired.error, /time limit/); assert.equal(expired.githubRetryAt, null);
  assert.deepEqual(ctx.calls.checks, [{ id: ctx.run.id, success: false }]);
});

test('Worker still rejects changed revisions after outage recovery', async t => {
  const ctx = workerContext(t);
  ctx.github.workflowEvidence = async () => { throw unavailable(); };
  await ctx.worker.tick(); expireCooldown(ctx);
  ctx.github.getPull = async () => ({ ...pull(), head: { sha: 'c'.repeat(40), repo: { full_name: ctx.config.repository } } });
  await ctx.worker.tick();
  const stale = ctx.store.getRun(ctx.run.id);
  assert.equal(stale.status, 'stale'); assert.equal(stale.githubRetryAt, null);
  assert.deepEqual(ctx.calls.checks, [{ id: ctx.run.id, success: false }]);
});

test('Worker never turns a mutation failure into a resumable read outage', async t => {
  const ctx = workerContext(t);
  ctx.store.updateRun(ctx.run.id, { dispatchAt: null });
  ctx.github.dispatch = async () => { ctx.calls.dispatch++; throw new DeskError('GITHUB_ERROR', 'GitHub rejected the operation (HTTP 503).', 502); };
  await ctx.worker.tick(); await ctx.worker.tick();
  const failed = ctx.store.getRun(ctx.run.id);
  assert.equal(failed.status, 'failed'); assert.ok(failed.dispatchAt); assert.equal(ctx.calls.dispatch, 1);
  assert.deepEqual(ctx.calls.checks, [{ id: ctx.run.id, success: false }]);
});

test('Worker cannot defer or publish approval after losing its lease during a read', async t => {
  const ctx = workerContext(t);
  ctx.github.workflowEvidence = async () => { ctx.store.db.prepare('UPDATE runs SET lease_until=0 WHERE id=?').run(ctx.run.id); throw unavailable(); };
  await ctx.worker.tick();
  assert.equal(ctx.store.getRun(ctx.run.id).githubReadFailures, undefined); assert.deepEqual(ctx.calls.checks, []);
});

test('Worker rechecks its original deadline before publishing a successful check', async t => {
  const ctx = workerContext(t);
  let reads = 0;
  ctx.github.getBranchSha = async () => {
    if (++reads === 2) ctx.config.maxRunMs = 0;
    return base;
  };
  await ctx.worker.tick();
  assert.equal(ctx.store.getRun(ctx.run.id).status, 'failed'); assert.deepEqual(ctx.calls.checks, [{ id: ctx.run.id, success: false }]);
});
