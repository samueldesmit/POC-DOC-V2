import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewRequests, newerPreview, previewView } from '../../client/preview-state.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const pull = { number: 4, headSha: head, baseSha: base };
const snapshot = overrides => ({
  prNumber: 4, headSha: head, baseSha: base, status: 'ready', updatedAt: '2026-11-12T14:00:00Z',
  markets: [
    { market: 'store', status: 'ready', links: [{ label: 'Homepage', url: 'https://example-store.myshopify.com/?preview_theme_id=1' }, { label: 'Cart', url: 'https://example-store.myshopify.com/cart?preview_theme_id=1' }] },
  ], ...overrides,
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(transport) {
  const events = [];
  const controller = createPreviewRequests({ request: transport, onStart: value => events.push(['start', value]), onResult: value => events.push(['result', value]), onError: value => events.push(['error', value]), onFinish: () => events.push(['finish']) });
  return { controller, events };
}

test('ready snapshots preserve every preview link for the store', () => {
  const view = previewView(snapshot(), pull);
  assert.equal(view.stale, false);
  assert.equal(view.busy, false);
  assert.deepEqual(view.markets.map(item => [item.market, item.links.length]), [['store', 2]]);
  assert.match(view.markets[0].links[1].url, /\/cart\?preview_theme_id=1$/);
});

test('new head, base or PR identity makes every old ready link unavailable', () => {
  for (const changed of [{ headSha: 'c'.repeat(40) }, { baseSha: 'd'.repeat(40) }, { number: 5 }]) {
    const view = previewView(snapshot(), { ...pull, ...changed });
    assert.equal(view.stale, true);
    assert.ok(view.markets.every(item => item.status === 'stale' && item.links.length === 0));
  }
});

test('failed generation exposes no links and keeps the store error', () => {
  const result = snapshot(); result.status = 'failed'; result.markets[0].status = 'failed'; result.markets[0].error = 'Store unavailable';
  const view = previewView(result, pull);
  assert.equal(view.markets[0].links.length, 0);
  assert.equal(view.markets[0].error, 'Store unavailable');
});

test('queued or running links are never exposed early and unsafe links are discarded', () => {
  const running = snapshot(); running.status = 'running'; running.markets[0].status = 'running';
  const view = previewView(running, pull);
  assert.equal(view.busy, true);
  assert.equal(view.markets[0].links.length, 0);
  assert.equal(previewView(running, { ...pull, headSha: 'new-head' }).busy, false);
  const ready = snapshot(); ready.markets[0].links.push({ label: 'Bad', url: 'javascript:alert(1)' }, { label: 'Bad', url: 'http://example.com' }, { label: 'Bad', url: '/relative' });
  assert.equal(previewView(ready, pull).markets[0].links.length, 2);
});

test('absent preview metadata stays empty and newer local status survives an older detail response', () => {
  const empty = previewView(null, pull);
  assert.equal(empty.stale, false); assert.equal(empty.busy, false);
  assert.ok(empty.markets.every(item => item.links.length === 0));
  const latest = snapshot({ updatedAt: '2026-11-12T14:05:00Z' });
  assert.strictEqual(newerPreview(latest, snapshot()), latest);
  assert.strictEqual(newerPreview(latest, null), latest);
  const next = snapshot({ updatedAt: '2026-11-12T14:06:00Z' });
  assert.strictEqual(newerPreview(latest, next), next);
});

test('creating the controller performs no request; only explicit refresh or generate calls transport', async () => {
  const calls = [];
  const result = { previews: snapshot(), configured: true };
  const { controller, events } = harness(async (...args) => { calls.push(args); return result; });
  await Promise.resolve();
  assert.deepEqual(calls, []); assert.deepEqual(events, []);
  await controller.load({ number: 4, headSha: head });
  await controller.load({ number: 4, headSha: head, generate: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], '/api/pulls/4/previews');
  assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[1][1].method, 'POST'); assert.deepEqual(calls[1][1].body, { headSha: head });
  assert.deepEqual(events.filter(([type]) => type === 'start').map(([, value]) => value), ['refresh', 'generate']);
  controller.dispose();
});

test('double clicks do not dispatch duplicate generation jobs', async () => {
  const pending = deferred(); let calls = 0;
  const { controller } = harness(() => { calls++; return pending.promise; });
  const first = controller.load({ number: 4, headSha: head, generate: true });
  assert.equal(await controller.load({ number: 4, headSha: head, generate: true }), false);
  assert.equal(calls, 1);
  pending.resolve({ previews: snapshot({ status: 'queued' }), configured: true }); await first;
  controller.dispose();
});

test('leaving a PR aborts its request and even a late transport response cannot update the next panel', async () => {
  const pending = deferred(); let signal;
  const { controller, events } = harness((_, options) => { signal = options.signal; return pending.promise; });
  const loading = controller.load({ number: 4, headSha: head });
  controller.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve({ previews: snapshot(), configured: true }); await loading;
  assert.deepEqual(events, [['start', 'refresh']]);
  assert.equal(await controller.load({ number: 5, headSha: head }), false);
});

test('a failed refresh reports an error without replacing saved preview metadata and permits manual retry', async () => {
  const failure = new Error('Store preview service unavailable'); let attempt = 0;
  const { controller, events } = harness(async () => { if (!attempt++) throw failure; return { previews: snapshot(), configured: true }; });
  await controller.load({ number: 4, headSha: head });
  assert.deepEqual(events, [['start', 'refresh'], ['error', failure], ['finish']]);
  await controller.load({ number: 4, headSha: head });
  assert.equal(events.filter(([type]) => type === 'result').length, 1);
  controller.dispose();
});

test('malformed response does not invent configuration or successful previews', async () => {
  const { controller, events } = harness(async () => ({ success: true }));
  await controller.load({ number: 4, headSha: head });
  assert.equal(events.some(([type]) => type === 'result'), false);
  assert.equal(events.find(([type]) => type === 'error')[1].message, 'The preview service returned an unreadable status. Use Refresh status to try again.');
  controller.dispose();
});
