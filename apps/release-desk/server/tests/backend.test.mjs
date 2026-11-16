import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, verifyWebhook, SESSION_CLOCK_TOLERANCE_SECONDS } from '../auth.mjs';
import { configuration, setupBlockers, ROLES, WORKFLOW } from '../config.mjs';
import { Store } from '../store.mjs';
import { Service } from '../service.mjs';
import { Worker } from '../worker.mjs';
import { GitHub, validateWorkflow } from '../github.mjs';
import { Reviews, parseReview, reviewInput, allApprove, DEMO_REVIEW_DELAYS } from '../reviews.mjs';
import { createApp } from '../app.mjs';
import { DeskError } from '../errors.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), changed = 'c'.repeat(40);
function config() { return { ...configuration({ GITHUB_REPOSITORY: 'example-org/theme-repo', SHOP_DOMAIN: 'example-store.myshopify.com',  SHOPIFY_API_KEY: 'test-client-id', SHOPIFY_API_SECRET: 'test-only-secret-32-characters-long', SHOPIFY_REVIEWER_IDS: '42', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'test-not-a-real-key', GITHUB_INSTALLATION_ID: '456', GITHUB_WEBHOOK_SECRET: 'test-webhook-secret', ANTHROPIC_API_KEY: 'test-ai-key' }), pollMs: 10 }; }
const actor = { id: '42', canMutate: true };
function pull() { return { number: 7, title: 'Fixture PR', html_url: 'https://github.com/example-org/theme-repo/pull/7', user: { login: 'fixture' }, state: 'open', merged: false, draft: false, changed_files: 1, head: { sha: head, repo: { full_name: 'example-org/theme-repo' } }, base: { sha: base, ref: 'staging', repo: { full_name: 'example-org/theme-repo' } }, mergeable: true, mergeable_state: 'clean' }; }
const approvals = () => ROLES.map(role => ({ role, status: 'completed', verdict: 'approve', summary: 'No concrete defect found in the supplied diff.', findings: [] }));
const files = () => [{ filename: 'theme/sections/example.liquid', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }];
function fakeGitHub() {
  return { pr: pull(), mainSha: base, merged: [], dispatched: [], checks: [], getPull: async function() { return structuredClone(this.pr); }, getBranchSha: async function() { return this.mainSha; }, listPulls: async function() { return [structuredClone(this.pr)]; }, listHistory: async () => [], compareBranches: async () => ({ ahead_by: 0, behind_by: 0, commits: [] }), createPull: async function(input) { this.created = input; return { number: 99, html_url: 'https://github.com/example-org/theme-repo/pull/99' }; }, protection: async () => ({ ready: true }), files: async () => files(), immutableFiles: async () => files(), dispatch: async function(run) { this.dispatched.push(run.id); }, startCheck: async () => 1234, finishCheck: async function(run, success) { this.checks.push({ id: run.id, success }); }, verifyCheck: async () => {}, workflowEvidence: async () => ({ status: 'completed', conclusion: 'success', runId: 12, attempt: 1 }), findWorkflowRun: async () => ({ status: 'completed', conclusion: 'success', runId: 12, attempt: 1 }), merge: async function(number, sha) { this.merged.push({ number, sha }); return { merged: true, sha: changed }; } };
}
function context(t) { const cfg = config(), store = new Store(':memory:'), github = fakeGitHub(); t.after(() => store.close()); return { config: cfg, store, github, service: new Service({ config: cfg, store, github }) }; }
function passed(ctx) { const run = ctx.store.enqueue(pull(), actor, ctx.config); return ctx.store.updateRun(run.id, { status: 'passed', checkId: 1234, reviews: approvals(), ci: { status: 'completed', conclusion: 'success', runId: 12, attempt: 1 } }); }
async function token(overrides = {}, options = {}) {
  const cfg = config(), now = Math.floor(Date.now() / 1000);
  const payload = { iss: `https://${cfg.shop}/admin`, dest: `https://${cfg.shop}`, aud: cfg.apiKey, sub: '42', exp: now + 60, nbf: now - 1, ...overrides };
  for (const key of options.omit || []) delete payload[key];
  return new SignJWT(payload).setProtectedHeader({ alg: options.alg || 'HS256' }).sign(new TextEncoder().encode(options.secret || cfg.apiSecret));
}

test('Shopify real JWT validation enforces signature, algorithm, audience, exact origin, issuer, user and time claims', async () => {
  assert.deepEqual(await authenticate(`Bearer ${await token()}`, config()), { id: '42', shop: config().shop, canMutate: true });
  const cases = [ [{ dest: 'https://example-store.myshopify.com.evil.test' }], [{ dest: 'http://example-store.myshopify.com' }], [{ dest: 'https://example-store.myshopify.com:443' }], [{ iss: 'https://other-store.myshopify.com/admin' }], [{ aud: 'another-app' }], [{ sub: '' }], [{ exp: 1 }], [{ nbf: Math.floor(Date.now() / 1000) + 100 }], [{}, { omit: ['exp'] }], [{}, { omit: ['nbf'] }], [{}, { secret: 'invalid-secret-with-enough-characters' }], [{}, { alg: 'HS384' }] ];
  for (const [payload, options] of cases) await assert.rejects(authenticate(`Bearer ${await token(payload, options)}`, config(), { onReject() {} }), error => error.status === 401);
  assert.equal((await authenticate(`Bearer ${await token({ sub: '43' })}`, config())).canMutate, false);
});
test('no automatic reviewer bootstrap and production rejects development token fallback', async t => {
  const ctx = context(t); ctx.config.reviewers.clear();
  await assert.rejects(ctx.service.test(7, head, actor), { code: 'REVIEWERS_MISSING' });
  const production = configuration({ GITHUB_REPOSITORY: 'example-org/theme-repo', SHOP_DOMAIN: 'example-store.myshopify.com',  NODE_ENV: 'production', ALLOW_DEV_GITHUB_TOKEN: 'true', GITHUB_TOKEN: 'dummy' }); assert.equal(production.githubToken, '');
  assert.equal(ctx.github.dispatched.length, 0);
});
test('HMAC verifies the exact raw bytes and rejects a modified body', () => {
  const raw = Buffer.from('{ "test": true }'), secret = 'fixture-secret'; const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifyWebhook(raw, signature, secret), true);
  assert.equal(verifyWebhook(Buffer.from('{"test":true}'), signature, secret), false);
  assert.equal(verifyWebhook(raw, 'sha256=bad', secret), false);
});
test('webhook delivery replay and runs remain durable across a database reopen', t => {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.tmp'); mkdirSync(directory, { recursive: true });
  const scratch = mkdtempSync(path.join(directory, 'backend-')); t.after(() => { assert.ok(scratch.startsWith(directory + path.sep)); rmSync(scratch, { recursive: true, force: true }); });
  const filename = path.join(scratch, 'review.sqlite'); let store = new Store(filename);
  const run = store.enqueue(pull(), actor, config()); assert.equal(store.receive('delivery-one', 'pull_request', { number: 7, action: 'opened' }), true); store.close();
  store = new Store(filename); assert.equal(store.getRun(run.id).headSha, head); assert.equal(store.receive('delivery-one', 'pull_request', { number: 7, action: 'opened' }), false); assert.equal(store.notifications().length, 1); store.close();
});
test('Express routes reject unauthenticated actions and unsigned webhooks; verified replay is idempotent', async t => {
  const ctx = context(t), app = createApp(ctx), server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/dashboard`)).status, 401);
  const raw = JSON.stringify({ repository: { full_name: ctx.config.repository }, number: 7, action: 'opened' });
  const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'delivery-api' };
  assert.equal((await fetch(`${origin}/webhooks/github`, { method: 'POST', headers, body: raw })).status, 401);
  headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', ctx.config.webhookSecret).update(raw).digest('hex')}`;
  assert.equal((await (await fetch(`${origin}/webhooks/github`, { method: 'POST', headers, body: raw })).json()).duplicate, false);
  assert.equal((await (await fetch(`${origin}/webhooks/github`, { method: 'POST', headers, body: raw })).json()).duplicate, true);
  const readOnly = await token({ sub: '99' });
  assert.equal((await fetch(`${origin}/api/pulls/7/test`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readOnly}` }, body: JSON.stringify({ headSha: head }) })).status, 403);
  const health = await (await fetch(`${origin}/health`)).json(); assert.deepEqual(health, { status: 'ok' });
});
test('review queue re-fetches PR and rejects a stale head, foreign repository and duplicate active run', async t => {
  const ctx = context(t);
  await assert.rejects(ctx.service.test(7, changed, actor), { code: 'STALE_HEAD' });
  ctx.github.pr.head.repo.full_name = 'foreign/fork'; await assert.rejects(ctx.service.test(7, head, actor), { code: 'PR_SCOPE' });
  ctx.github.pr = pull(); await ctx.service.test(7, head, actor); await assert.rejects(ctx.service.test(7, head, actor), { code: 'RUN_IN_PROGRESS' });
  assert.equal(ctx.store.listRuns().length, 1);
});
test('merge rejects stale head and base even for a previously approved run', async t => {
  const ctx = context(t), run = passed(ctx);
  ctx.github.pr.head.sha = changed; await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'STALE_HEAD' });
  ctx.github.pr = pull(); ctx.github.pr.base.sha = changed; await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'STALE_BASE' }); assert.equal(ctx.github.merged.length, 0);
});
test('merge blocks unknown/dirty GitHub status, missing protection, failed reviews and workflow reruns', async t => {
  const ctx = context(t), run = passed(ctx);
  for (const state of ['unknown', 'dirty', 'blocked', 'behind']) { ctx.github.pr.mergeable_state = state; await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'MERGE_BLOCKED' }); }
  ctx.github.pr = pull(); ctx.github.protection = async () => ({ ready: false }); await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'MERGE_BLOCKED' });
  ctx.github.protection = async () => ({ ready: true }); ctx.github.workflowEvidence = async () => ({ status: 'completed', conclusion: 'success', attempt: 2 }); await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'CI_CHANGED' });
  ctx.store.updateRun(run.id, { reviews: approvals().slice(0, 2) }); await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'MERGE_BLOCKED' }); assert.equal(ctx.github.merged.length, 0);
});
test('head changes during merge validation are detected by the final fetch', async t => {
  const ctx = context(t), run = passed(ctx);
  ctx.github.verifyCheck = async () => { ctx.github.pr.head.sha = changed; };
  await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'STALE_HEAD' }); assert.equal(ctx.github.merged.length, 0);
});
test('concurrent merge requests serialize; only the exact approved head is submitted once', async t => {
  const ctx = context(t), run = passed(ctx);
  const results = await Promise.allSettled([ctx.service.merge(7, { headSha: head, runId: run.id }, actor), ctx.service.merge(7, { headSha: head, runId: run.id }, actor)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.deepEqual(ctx.github.merged, [{ number: 7, sha: head }]); assert.equal(ctx.store.getRun(run.id).status, 'merged');
});
test('uncertain merge response is durably blocked and never retried automatically', async t => {
  const ctx = context(t), run = passed(ctx); ctx.github.merge = async () => { throw new Error('network lost after remote write'); };
  await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'MERGE_UNKNOWN' }); assert.equal(ctx.store.getRun(run.id).status, 'merge_unknown');
  await assert.rejects(ctx.service.test(7, head, actor), { code: 'MERGE_UNKNOWN' });
});
test('workflow correlation rejects matching titles from wrong workflow, head, event or repository', () => {
  const run = { id: randomUUID(), baseSha: base, baseBranch: 'staging', createdAt: new Date().toISOString() };
  const workflow = { display_title: `Release Desk ${run.id}`, event: 'workflow_dispatch', head_branch: 'staging', head_sha: base, path: WORKFLOW, repository: { full_name: config().repository }, created_at: run.createdAt };
  assert.doesNotThrow(() => validateWorkflow(run, workflow, config()));
  for (const change of [{ path: '.github/workflows/evil.yml' }, { head_sha: head }, { event: 'pull_request' }, { head_branch: 'feature' }, { repository: { full_name: 'other/repo' } }, { display_title: 'Release Desk other' }]) assert.throws(() => validateWorkflow(run, { ...workflow, ...change }, config()), { code: 'CI_CORRELATION' });
});
test('worker resumes durable dispatch intent without dispatching the workflow twice', async t => {
  const ctx = context(t), initial = ctx.store.enqueue(pull(), actor, ctx.config);
  ctx.store.updateRun(initial.id, { status: 'running', checkId: 12, dispatchAt: new Date().toISOString(), reviews: approvals() });
  const worker = new Worker({ ...ctx, reviews: { run: async () => { throw new Error('must not repeat completed AI review'); } } }); await worker.tick();
  assert.equal(ctx.github.dispatched.length, 0); assert.equal(ctx.store.getRun(initial.id).status, 'passed');
});
test('worker cannot approve missing or failed AI results and publishes a failed check', async t => {
  const ctx = context(t), run = ctx.store.enqueue(pull(), actor, ctx.config);
  const worker = new Worker({ ...ctx, reviews: { run: async () => [{ role: 'security', status: 'error', verdict: null, findings: [] }] } }); await worker.tick();
  assert.equal(ctx.store.getRun(run.id).status, 'failed'); assert.equal(ctx.github.checks.at(-1).success, false);
});
test('worker invalidates evidence when the base changes during review', async t => {
  const ctx = context(t), run = ctx.store.enqueue(pull(), actor, ctx.config);
  const worker = new Worker({ ...ctx, reviews: { run: async () => { ctx.github.mainSha = changed; return approvals(); } } }); await worker.tick();
  assert.equal(ctx.store.getRun(run.id).status, 'stale'); assert.equal(ctx.github.checks.at(-1).success, false);
});
test('diff coverage rejects truncated patches, binary files and oversized input', () => {
  assert.ok(reviewInput(files(), config()).includes('example.liquid'));
  assert.throws(() => reviewInput([{ ...files()[0], additions: 2 }], config()), { code: 'DIFF_INCOMPLETE' });
  assert.throws(() => reviewInput([{ ...files()[0], patch: undefined }], config()), { code: 'DIFF_INCOMPLETE' });
  assert.throws(() => reviewInput(files(), { ...config(), maxDiffBytes: 1 }), { code: 'DIFF_LIMIT' });
});
test('AI structured results fail closed on truncation, malformed output or conflicting approval', async () => {
  const response = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ verdict: 'approve', summary: 'Reviewed supplied diff.', findings: [] }) }] };
  assert.equal(parseReview(response, 'security').verdict, 'approve');
  assert.throws(() => parseReview({ ...response, stop_reason: 'max_tokens' }, 'security'), { code: 'REVIEW_INCOMPLETE' });
  assert.throws(() => parseReview({ ...response, content: [{ type: 'text', text: 'APPROVE' }] }, 'security'), { code: 'REVIEW_INVALID' });
  const missing = new Reviews({ ...config(), anthropicKey: '' }); await assert.rejects(missing.run('dummy'), { code: 'AI_UNCONFIGURED' });
});
test('three Claude reviewers run in parallel without execution tools and produce role-bound results', async () => {
  const calls = []; let concurrent = 0, peak = 0;
  const client = { messages: { create: async params => { calls.push(params); concurrent++; peak = Math.max(peak, concurrent); await new Promise(resolve => setTimeout(resolve, 5)); concurrent--; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ verdict: 'approve', summary: 'No issue.', findings: [] }) }] }; } } };
  const results = await new Reviews(config(), client).run('untrusted fixture diff');
  assert.equal(peak, 3); assert.deepEqual(results.map(result => result.role), ROLES); assert.ok(calls.every(call => !('tools' in call) && call.output_config.format.type === 'json_schema'));
});
test('GitHub merge transport submits an exact SHA and cannot call another repository', async () => {
  const calls = [], cfg = { ...config(), githubAppId: '', githubPrivateKey: '', githubInstallationId: '', githubToken: 'dummy-test-token' };
  const github = new GitHub(cfg, { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ merged: true, sha: changed }), { status: 200 }); } });
  await github.merge(7, head); assert.equal(JSON.parse(calls[0].init.body).sha, head); assert.equal(calls[0].init.method, 'PUT');
  await assert.rejects(github.request('GET', '/repos/other/repo/pulls'), { code: 'GITHUB_ROUTE' }); assert.equal(calls.length, 1);
});
test('AI review uses immutable base/head patches even when the PR head changes A-to-B-to-A', async t => {
  const ctx = context(t), run = ctx.store.enqueue(pull(), actor, ctx.config); let observed = '';
  ctx.github.files = async () => { throw new Error('Mutable PR file endpoint must never supply AI evidence.'); };
  ctx.github.immutableFiles = async (baseSha, headSha) => { assert.equal(baseSha, base); assert.equal(headSha, head); ctx.github.pr.head.sha = changed; ctx.github.pr.head.sha = head; return files(); };
  const worker = new Worker({ ...ctx, reviews: { run: async input => { observed = input; return approvals(); } } }); await worker.tick();
  assert.equal(ctx.store.getRun(run.id).status, 'passed'); assert.ok(observed.includes('example.liquid'));
});
test('immutable comparison transport pins SHA path and refuses incomplete commit pagination', async () => {
  const cfg = { ...config(), githubAppId: '', githubPrivateKey: '', githubInstallationId: '', githubToken: 'dummy' }; let urlSeen;
  const data = { base_commit: { sha: base }, commits: [{ sha: head }], total_commits: 1, files: files() };
  const github = new GitHub(cfg, { fetchImpl: async url => { urlSeen = url; return new Response(JSON.stringify(data), { status: 200 }); } });
  await github.immutableFiles(base, head); assert.ok(urlSeen.includes(`/compare/${base}...${head}?`));
  data.total_commits = 101; await assert.rejects(github.immutableFiles(base, head), { code: 'DIFF_INCOMPLETE' });
});
test('unknown merge reconciliation never merges and requires a fresh review after confirmed non-merge', async t => {
  const ctx = context(t), run = passed(ctx); ctx.store.updateRun(run.id, { status: 'merge_unknown' });
  await assert.rejects(ctx.service.reconcile(7, run.id, actor), { code: 'MERGE_SETTLING' });
  const row = ctx.store.getRun(run.id); row.updatedAt = new Date(Date.now() - 121_000).toISOString();
  ctx.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(row), run.id);
  const result = await ctx.service.reconcile(7, run.id, actor); assert.equal(result.status, 'failed'); assert.equal(ctx.github.merged.length, 0);
  const next = await ctx.service.test(7, head, actor); assert.notEqual(next.id, run.id); assert.equal(next.status, 'queued');
});
test('expired worker leases cannot overwrite another worker and live merge locks are not recovered', t => {
  const ctx = context(t), run = ctx.store.enqueue(pull(), actor, ctx.config); ctx.store.claim('worker-one');
  ctx.store.db.prepare('UPDATE runs SET lease_until=0 WHERE id=?').run(run.id); ctx.store.claim('worker-two');
  assert.throws(() => ctx.store.updateLeasedRun(run.id, 'worker-one', { status: 'passed' }), { code: 'LEASE_LOST' });
  ctx.store.updateRun(run.id, { status: 'merging' }); assert.equal(ctx.store.lock(7, 'merge-owner'), true); ctx.store.recoverMerges(); assert.equal(ctx.store.getRun(run.id).status, 'merging');
  ctx.store.unlock(7, 'merge-owner'); ctx.store.recoverMerges(); assert.equal(ctx.store.getRun(run.id).status, 'merge_unknown');
});
test('branch protection must be strict, administrator-enforced and pinned to this GitHub App', async () => {
  const cfg = { ...config(), githubPrivateKey: '', githubInstallationId: '', githubToken: 'dummy' };
  const policy = { required_status_checks: { strict: true, checks: [{ context: 'Release Desk', app_id: 123 }] }, enforce_admins: { enabled: true } };
  const github = new GitHub(cfg, { fetchImpl: async () => new Response(JSON.stringify(policy), { status: 200 }) });
  assert.equal((await github.protection('staging')).ready, true);
  policy.required_status_checks.checks[0].app_id = -1; assert.equal((await github.protection('staging')).ready, false);
  policy.required_status_checks.checks[0].app_id = 123; policy.required_status_checks.strict = false; assert.equal((await github.protection('staging')).ready, false);
  policy.required_status_checks.strict = true; policy.enforce_admins.enabled = false; assert.equal((await github.protection('staging')).ready, false);
});
test('successful workflow summary cannot substitute for missing, skipped or failed required jobs', async () => {
  const cfg = { ...config(), githubAppId: '', githubPrivateKey: '', githubInstallationId: '', githubToken: 'dummy' };
  const run = { id: randomUUID(), baseSha: base, baseBranch: 'staging', createdAt: new Date().toISOString() };
  const workflow = { id: 12, run_attempt: 1, status: 'completed', conclusion: 'success', display_title: `Release Desk ${run.id}`, event: 'workflow_dispatch', head_branch: 'staging', head_sha: base, path: WORKFLOW, repository: { full_name: cfg.repository }, created_at: run.createdAt };
  let jobs = [{ name: 'review-checks', status: 'completed', conclusion: 'success' }, { name: 'theme-check', status: 'completed', conclusion: 'success' }];
  const github = new GitHub(cfg, { fetchImpl: async url => new Response(JSON.stringify(url.includes('/jobs?') ? { total_count: jobs.length, jobs } : workflow), { status: 200 }) });
  assert.equal((await github.workflowEvidence(run, 12)).conclusion, 'success');
  jobs = []; await assert.rejects(github.workflowEvidence(run, 12), { code: 'CI_FAILED' });
  jobs = [{ name: 'review-checks', status: 'completed', conclusion: 'skipped' }, { name: 'theme-check', status: 'completed', conclusion: 'success' }]; await assert.rejects(github.workflowEvidence(run, 12), { code: 'CI_FAILED' });
});
test('demo review mode is explicit, removes only the Anthropic credential requirement and persists on the run', async t => {
  const ctx = context(t); ctx.config.anthropicKey = '';
  assert.ok(setupBlockers(ctx.config).some(item => item.code === 'ANTHROPIC_KEY_MISSING'));
  await assert.rejects(ctx.service.test(7, head, actor), { code: 'SETUP_INCOMPLETE' });
  ctx.config.reviewMode = 'demo'; assert.equal(setupBlockers(ctx.config).length, 0);
  const run = await ctx.service.test(7, head, actor); assert.equal(ctx.store.getRun(run.id).reviewMode, 'demo');
  assert.equal((await ctx.service.dashboard(actor)).reviewMode, 'demo');
  ctx.config.webhookSecret = ''; assert.ok(setupBlockers(ctx.config).some(item => item.code === 'WEBHOOK_SECRET_MISSING'));
  ctx.config.reviewMode = 'typo'; assert.ok(setupBlockers(ctx.config).some(item => item.code === 'REVIEW_MODE_INVALID'));
});
test('demo reviewers stage persisted progress without calling Anthropic or claiming to inspect a diff', async t => {
  const ctx = context(t); ctx.config.reviewMode = 'demo'; ctx.config.anthropicKey = '';
  const run = ctx.store.enqueue(pull(), actor, ctx.config), sleepers = [];
  const reviews = new Reviews(ctx.config, { messages: { create: async () => { throw new Error('demo must never call Anthropic'); } } }, { sleep: ms => new Promise(resolve => sleepers.push({ ms, resolve })) });
  ctx.github.immutableFiles = async () => { throw new Error('demo does not pretend to inspect code'); };
  const worker = new Worker({ ...ctx, reviews }), work = worker.tick();
  for (let i = 0; i < 20 && sleepers.length < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sleepers.map(item => item.ms), DEMO_REVIEW_DELAYS);
  let state = ctx.store.getRun(run.id); assert.equal(state.stage, 'demo_reviewing'); assert.ok(state.reviews.every(review => review.status === 'running' && review.simulated));
  sleepers[0].resolve(); await new Promise(resolve => setImmediate(resolve));
  state = ctx.store.getRun(run.id); assert.equal(state.reviews[0].status, 'completed'); assert.equal(state.reviews[1].status, 'running');
  sleepers[1].resolve(); sleepers[2].resolve(); await work;
  state = ctx.store.getRun(run.id); assert.equal(state.status, 'passed'); assert.equal(state.ci.conclusion, 'success');
  assert.ok(state.reviews.every(review => review.simulated && review.summary.includes('No AI code review was performed')));
  assert.equal(ctx.github.dispatched.length, 1); assert.equal(ctx.github.merged.length, 0);
});
test('simulated reviewers cannot substitute for real CI, enter live mode or bypass manual authorization', async t => {
  const ctx = context(t); ctx.config.reviewMode = 'demo'; ctx.config.anthropicKey = '';
  const run = passed(ctx), simulated = approvals().map(review => ({ ...review, simulated: true }));
  ctx.store.updateRun(run.id, { reviews: simulated });
  assert.equal(allApprove(simulated, 'demo'), true); assert.equal(allApprove(simulated, 'live'), false); assert.equal(allApprove(approvals(), 'demo'), false);
  await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, { id: '99', canMutate: false }), { code: 'FORBIDDEN' });
  ctx.store.updateRun(run.id, { ci: { status: 'completed', conclusion: 'failure', runId: 12, attempt: 1 } });
  await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'MERGE_BLOCKED' });
  ctx.store.updateRun(run.id, { ci: { status: 'completed', conclusion: 'success', runId: 12, attempt: 1 } });
  ctx.config.reviewMode = 'live'; ctx.config.anthropicKey = 'dummy-live-key';
  await assert.rejects(ctx.service.merge(7, { headSha: head, runId: run.id }, actor), { code: 'MERGE_BLOCKED' });
  ctx.config.reviewMode = 'demo'; assert.equal((await ctx.service.merge(7, { headSha: head, runId: run.id }, actor)).merged, true);
  assert.equal(ctx.github.merged.length, 1);
});
test('GitHub check titles and summaries disclose demo reviews on start and completion', async () => {
  const cfg = { ...config(), githubAppId: '', githubPrivateKey: '', githubInstallationId: '', githubToken: 'dummy', reviewMode: 'demo' }, bodies = [];
  const github = new GitHub(cfg, { fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 123 }), { status: 200 }); } });
  const run = { id: randomUUID(), headSha: head, baseSha: base, reviewMode: 'demo', checkId: 123 };
  await github.startCheck(run); await github.finishCheck(run, true, 'Real CI passed.');
  assert.ok(bodies.every(body => /simulated AI/i.test(body.output.title) && /no AI code review/i.test(body.output.summary)));
  assert.equal(bodies[1].conclusion, 'success');
});
test('Shopify session validation tolerates only a bounded five-second exp/nbf clock skew', async () => {
  assert.equal(SESSION_CLOCK_TOLERANCE_SECONDS, 5);
  const now = Math.floor(Date.now() / 1000), diagnostics = [];
  const options = { onReject: diagnostic => diagnostics.push(diagnostic) };
  assert.equal((await authenticate(`Bearer ${await token({ nbf: now + 4 })}`, config(), options)).id, '42');
  assert.equal((await authenticate(`Bearer ${await token({ exp: now - 4 })}`, config(), options)).id, '42');
  await assert.rejects(authenticate(`Bearer ${await token({ nbf: now + 6 })}`, config(), options), { code: 'INVALID_SESSION', status: 401 });
  await assert.rejects(authenticate(`Bearer ${await token({ exp: now - 6 })}`, config(), options), { code: 'INVALID_SESSION', status: 401 });
  assert.deepEqual(diagnostics, [
    { event: 'shopify.session_rejected', code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'nbf' },
    { event: 'shopify.session_rejected', code: 'ERR_JWT_EXPIRED', claim: 'exp' },
  ]);
});
test('auth rejection diagnostics contain only fixed reason fields, never the token or claim values', async () => {
  const diagnostics = [], secretAudience = 'private-audience-value', jwt = await token({ aud: secretAudience, sub: '987654321' });
  await assert.rejects(authenticate(`Bearer ${jwt}`, config(), { onReject: diagnostic => diagnostics.push(diagnostic) }), { status: 401 });
  assert.deepEqual(diagnostics, [{ event: 'shopify.session_rejected', code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'aud' }]);
  const text = JSON.stringify(diagnostics); assert.ok(!text.includes(jwt) && !text.includes(secretAudience) && !text.includes('987654321') && !text.includes(config().apiSecret));
  await assert.rejects(authenticate(`Bearer ${await token({ exp: 1 })}`, config(), { onReject() { throw new Error('logger unavailable'); } }), { status: 401 });
});
test('dashboard separates open PRs from GitHub-authoritative merged and closed history', async t => {
  const ctx = context(t), saved = passed(ctx);
  const merged = { ...pull(), state: 'closed', created_at: '2026-11-10T09:00:00Z', closed_at: '2026-11-12T10:00:00Z', merged_at: '2026-11-12T10:00:00Z', merge_commit_sha: changed };
  delete merged.merged; // GitHub list API can omit this detail-only boolean.
  const closed = { ...pull(), number: 8, state: 'closed', closed_at: '2026-11-11T08:00:00Z', merged_at: null, merge_commit_sha: changed };
  const otherBase = { ...closed, number: 10, base: { ...closed.base, ref: 'release' } };
  ctx.github.pr.number = 9; ctx.github.listHistory = async () => [merged, closed, otherBase];
  const data = await ctx.service.dashboard(actor);
  assert.deepEqual(data.pulls.map(pr => pr.number), [9]); assert.deepEqual(data.history.map(pr => pr.number), [7, 8]);
  assert.equal(data.history[0].status, 'merged'); assert.equal(data.history[0].merged, true); assert.equal(data.history[0].mergedAt, merged.merged_at); assert.equal(data.history[0].closedAt, merged.closed_at); assert.equal(data.history[0].createdAt, merged.created_at); assert.equal(data.history[0].mergeCommitSha, changed);
  assert.equal(data.history[0].latestRun.id, saved.id); assert.equal(data.history[0].latestRun.status, 'passed'); // Reading GitHub history never rewrites review evidence.
  assert.equal(data.history[1].status, 'closed'); assert.equal(data.history[1].merged, false); assert.equal(data.history[1].mergedAt, null); assert.equal(data.history[1].mergeCommitSha, null); assert.equal(data.history[1].latestRun, null);
  assert.ok(data.history.every(pr => pr.mergeEligibility.allowed === false));
});
test('historical PR details retain saved review runs when the file list exceeds review limits', async t => {
  const ctx = context(t), saved = passed(ctx);
  Object.assign(ctx.github.pr, { state: 'closed', merged: true, merged_at: '2026-11-12T10:00:00Z', closed_at: '2026-11-12T10:00:00Z', merged_by: { login: 'outside-app-reviewer' }, merge_commit_sha: changed });
  ctx.github.files = async () => { throw new DeskError('DIFF_LIMIT', 'The PR exceeds the supported review file limit.'); };
  const detail = await ctx.service.detail(7);
  assert.equal(detail.pull.status, 'merged'); assert.equal(detail.pull.mergedBy, 'outside-app-reviewer'); assert.equal(detail.pull.mergeEligibility.allowed, false);
  assert.equal(detail.runs[0].id, saved.id); assert.equal(detail.runs[0].status, 'passed'); assert.deepEqual(detail.files, []); assert.match(detail.filesUnavailableReason, /file limit/);
  ctx.github.pr = pull(); await assert.rejects(ctx.service.detail(7), { code: 'DIFF_LIMIT' });
});
test('closed and externally merged PRs cannot be tested or merged even with saved passing evidence', async t => {
  const ctx = context(t), saved = passed(ctx);
  for (const merged of [false, true]) {
    Object.assign(ctx.github.pr, { state: 'closed', merged, merged_at: merged ? '2026-11-12T10:00:00Z' : null });
    await assert.rejects(ctx.service.test(7, head, actor), { code: 'PR_INELIGIBLE' });
    await assert.rejects(ctx.service.merge(7, { headSha: head, runId: saved.id }, actor), { code: 'PR_INELIGIBLE' });
  }
  assert.equal(ctx.store.listRuns(7).length, 1); assert.equal(ctx.github.dispatched.length, 0); assert.equal(ctx.github.merged.length, 0);
});
test('history loading failures preserve the current open inbox and expose an honest separate error', async t => {
  const ctx = context(t); ctx.github.listHistory = async () => { throw new Error('upstream unavailable'); };
  const data = await ctx.service.dashboard(actor);
  assert.equal(data.pulls.length, 1); assert.deepEqual(data.history, []); assert.match(data.historyError, /could not be loaded/); assert.equal(data.setup.ready, true);
});
test('GitHub history query keeps only closed staging- and live-target PRs and caps results at fifty', async () => {
  const cfg = { ...config(), githubAppId: '', githubPrivateKey: '', githubInstallationId: '', githubToken: 'dummy' }; let requested;
  const github = new GitHub(cfg, { fetchImpl: async url => { requested = new URL(url); return new Response(JSON.stringify([...Array.from({ length: 51 }, (_, index) => ({ number: index + 1, base: { ref: index % 2 ? 'main' : 'staging' } })), { number: 99, base: { ref: 'feature' } }]), { status: 200 }); } });
  const result = await github.listHistory();
  assert.equal(requested.searchParams.get('state'), 'closed'); assert.equal(requested.searchParams.get('base'), null); assert.equal(requested.searchParams.get('per_page'), '100'); assert.equal(requested.searchParams.get('sort'), 'updated'); assert.equal(requested.searchParams.get('direction'), 'desc'); assert.equal(result.length, 50);
});

test('release opens one staging-to-live PR, only when staging is ahead, and reuses an open one', async t => {
  const ctx = context(t);
  await assert.rejects(ctx.service.createRelease(actor), { code: 'NOTHING_TO_RELEASE' });
  ctx.github.compareBranches = async (baseRef, headRef) => { assert.deepEqual([baseRef, headRef], ['main', 'staging']); return { ahead_by: 2, behind_by: 0, commits: [{ commit: { message: 'Hero spacing\n\nbody' } }, { commit: { message: 'Footer links' } }] }; };
  const created = await ctx.service.createRelease(actor);
  assert.deepEqual(created, { created: true, number: 99, url: 'https://github.com/example-org/theme-repo/pull/99' });
  assert.equal(ctx.github.created.head, 'staging'); assert.equal(ctx.github.created.base, 'main'); assert.match(ctx.github.created.body, /- Hero spacing\n- Footer links/);
  ctx.github.listPulls = async () => [{ ...pull(), number: 50, html_url: 'u', head: { ...pull().head, ref: 'staging' }, base: { ...pull().base, ref: 'main' } }];
  assert.deepEqual(await ctx.service.createRelease(actor), { created: false, number: 50, url: 'u' });
  await assert.rejects(ctx.service.createRelease({ id: '43', canMutate: false }), { code: 'FORBIDDEN' });
});
test('only staging itself can be tested or merged into live, and runs target their own base branch', async t => {
  const ctx = context(t);
  ctx.github.pr = { ...pull(), base: { ...pull().base, ref: 'main' }, head: { ...pull().head, ref: 'feature/hero' } };
  await assert.rejects(ctx.service.test(7, head, actor), { code: 'PR_SCOPE' });
  ctx.github.pr = { ...pull(), base: { ...pull().base, ref: 'main' }, head: { ...pull().head, ref: 'staging' } };
  const run = await ctx.service.test(7, head, actor);
  assert.equal(run.baseBranch, 'main');
  ctx.github.pr = { ...pull(), base: { ...pull().base, ref: 'other' } };
  await assert.rejects(ctx.service.test(7, head, actor), { code: 'PR_SCOPE' });
});
test('repository, store and branches come only from the environment and are validated', () => {
  const cfg = configuration({ GITHUB_REPOSITORY: 'bad repo', SHOP_DOMAIN: 'evil.example.com', STAGING_BRANCH: 'main' });
  assert.equal(cfg.repository, ''); assert.equal(cfg.shop, '');
  const codes = setupBlockers(cfg).map(blocker => blocker.code);
  for (const code of ['REPOSITORY_MISSING', 'SHOP_MISSING', 'BRANCHES_INVALID']) assert(codes.includes(code));
});
