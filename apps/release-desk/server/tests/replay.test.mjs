import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReplayState, replayReducer, startReplayClock, REPLAY_DURATION_MS } from '../../client/replay-state.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
function sourcePull(overrides = {}) {
  return { number: 4, title: 'Visible theme demo', headSha: head, baseSha: base, baseBranch: 'main', state: 'open', merged: false,
    url: 'https://github.com/example-org/theme-repo/pull/4', mergeEligibility: { allowed: true },
    latestRun: { id: 'real-saved-run', status: 'passed', headSha: head, ci: { url: 'https://github.com/example-org/theme-repo/actions/runs/123', conclusion: 'success' } },
    files: [{ path: 'theme/assets/example.css', status: 'modified', additions: 2, deletions: 1, url: 'https://github.com/example-org/theme-repo/blob/main/theme/assets/example.css' }],
    ...overrides,
  };
}
function freezeDeep(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeDeep(child);
  return Object.freeze(value);
}
const begin = state => replayReducer(state, { type: 'START', sessionId: state.sessionId });
const tick = (state, elapsedMs, sessionId = state.sessionId) => replayReducer(state, { type: 'TICK', sessionId, elapsedMs });

test('replay begins idle and cannot complete without the explicit local start action', () => {
  const idle = createReplayState({ sessionId: 'replay-one', pr: sourcePull() });
  assert.equal(idle.phase, 'idle'); assert.equal(idle.elapsedMs, 0);
  assert.ok(idle.reviews.every(review => review.status === 'pending' && review.verdict === null && review.simulated === true));
  assert.deepEqual(idle.ci, { status: 'pending', conclusion: null, simulated: true });
  assert.strictEqual(tick(idle, REPLAY_DURATION_MS), idle);
  assert.strictEqual(replayReducer(idle, { type: 'START', sessionId: 'another-session' }), idle);
});

test('reviewer and CI stages progress before completion and every result remains simulated', () => {
  let state = begin(createReplayState({ sessionId: 'replay-one', pr: sourcePull() }));
  assert.equal(state.phase, 'running'); assert.equal(state.reviews[0].status, 'running'); assert.equal(state.ci.status, 'pending');
  state = tick(state, 4000);
  assert.equal(state.reviews[0].status, 'completed'); assert.equal(state.reviews[1].status, 'running'); assert.equal(state.reviews[2].status, 'pending');
  state = tick(state, 10000);
  assert.ok(state.reviews.every(review => review.status === 'completed')); assert.equal(state.ci.status, 'in_progress'); assert.equal(state.ci.conclusion, null);
  const finished = tick(state, REPLAY_DURATION_MS + 5000);
  assert.equal(finished.phase, 'passed'); assert.equal(finished.elapsedMs, REPLAY_DURATION_MS);
  assert.ok(finished.reviews.every(review => review.verdict === 'approve' && review.simulated === true));
  assert.deepEqual(finished.ci, { status: 'completed', conclusion: 'success', simulated: true });
  assert.equal(finished.mergeEligibility, undefined); assert.equal(finished.ci.url, undefined); assert.equal(finished.ci.runId, undefined);
});

test('reset restores the presentation to untested without permitting stale timer events to advance it', () => {
  const old = tick(begin(createReplayState({ sessionId: 'old-session', pr: sourcePull() })), 6500);
  const fresh = replayReducer(old, { type: 'RESET', sessionId: 'fresh-session' });
  assert.equal(fresh.phase, 'idle'); assert.equal(fresh.elapsedMs, 0); assert.equal(fresh.sessionId, 'fresh-session');
  assert.ok(fresh.reviews.every(review => review.status === 'pending')); assert.equal(fresh.ci.conclusion, null);
  assert.strictEqual(tick(fresh, REPLAY_DURATION_MS, 'old-session'), fresh);
  assert.strictEqual(replayReducer(fresh, { type: 'START', sessionId: 'old-session' }), fresh);
  assert.strictEqual(replayReducer(fresh, { type: 'RESET', sessionId: 'fresh-session' }), fresh);
  assert.strictEqual(replayReducer(fresh, { type: 'RESET', sessionId: '' }), fresh);
  const running = begin(fresh);
  assert.strictEqual(tick(running, REPLAY_DURATION_MS, 'old-session'), running);
});

test('a completed replay can reset and complete repeatedly without inheriting prior results', () => {
  let state = createReplayState({ sessionId: 'cycle-0', pr: sourcePull() });
  for (let cycle = 0; cycle < 3; cycle++) {
    state = tick(begin(state), REPLAY_DURATION_MS);
    assert.equal(state.phase, 'passed');
    assert.strictEqual(begin(state), state); // Start never silently restarts a completed run.
    state = replayReducer(state, { type: 'RESET', sessionId: `cycle-${cycle + 1}` });
    assert.equal(state.phase, 'idle'); assert.equal(state.ci.status, 'pending'); assert.ok(state.reviews.every(review => review.verdict === null));
  }
});

test('restart atomically begins from idle, running or passed without changing the PR or retaining results', () => {
  const pr = freezeDeep(sourcePull({ state: 'closed', merged: true })), before = JSON.stringify(pr);
  const idle = createReplayState({ sessionId: 'before-restart', pr });
  for (const prior of [idle, tick(begin(idle), 10000), tick(begin(idle), REPLAY_DURATION_MS)]) {
    freezeDeep(prior);
    const previous = JSON.stringify(prior);
    const fresh = replayReducer(prior, { type: 'RESTART', sessionId: `restart-${prior.phase}` });
    assert.equal(fresh.phase, 'running'); assert.equal(fresh.elapsedMs, 0);
    assert.equal(fresh.sessionId, `restart-${prior.phase}`);
    assert.deepEqual(fresh.reviews.map(review => review.status), ['running', 'pending', 'pending']);
    assert.ok(fresh.reviews.every(review => review.verdict === null && review.simulated === true));
    assert.deepEqual(fresh.ci, { status: 'pending', conclusion: null, simulated: true });
    assert.deepEqual(fresh.pr, prior.pr); assert.notStrictEqual(fresh.pr.files, prior.pr.files);
    assert.equal(JSON.stringify(prior), previous); assert.equal(JSON.stringify(pr), before);
    assert.strictEqual(tick(fresh, REPLAY_DURATION_MS, prior.sessionId), fresh);
    for (const sessionId of [fresh.sessionId, '', undefined, null]) {
      assert.strictEqual(replayReducer(fresh, { type: 'RESTART', sessionId }), fresh);
    }
    assert.equal(fresh.mergeEligibility, undefined); assert.equal(fresh.ci.url, undefined); assert.equal(fresh.ci.runId, undefined);
  }
});

test('rapid restarts use a fresh clock and stale or cancelled callbacks cannot finish the latest run', () => {
  let time = 1000, state = begin(createReplayState({ sessionId: 'clock-one', pr: sourcePull() }));
  const callbacks = [], cancelled = [];
  const startClock = () => startReplayClock({
    sessionId: state.sessionId, onTick: event => { state = replayReducer(state, event); }, now: () => time,
    schedule: callback => { callbacks.push(callback); return callbacks.length; }, cancel: id => cancelled.push(id),
  });
  const stopFirst = startClock();
  time += 10000; callbacks[0](); assert.equal(state.elapsedMs, 10000);
  state = replayReducer(state, { type: 'RESTART', sessionId: 'clock-two' });
  callbacks[0](); assert.equal(state.elapsedMs, 0); // A queued tick can arrive before effect cleanup.
  stopFirst();
  const stopSecond = startClock();
  time += 150; callbacks[1](); assert.equal(state.elapsedMs, 150);
  state = replayReducer(state, { type: 'RESTART', sessionId: 'clock-three' });
  stopSecond(); startClock();
  time += REPLAY_DURATION_MS - 1;
  callbacks[0](); callbacks[1](); assert.equal(state.elapsedMs, 0);
  callbacks[2](); assert.equal(state.phase, 'running'); assert.equal(state.elapsedMs, REPLAY_DURATION_MS - 1);
  time += 1; callbacks[2](); assert.equal(state.phase, 'passed'); assert.deepEqual(cancelled, [1, 2, 3]);
  callbacks[2](); assert.deepEqual(cancelled, [1, 2, 3]);
});

test('replay progress is monotonic and ignores invalid timing values', () => {
  const running = tick(begin(createReplayState({ sessionId: 'timing', pr: sourcePull() })), 7000);
  assert.deepEqual(tick(running, 1000), running);
  for (const elapsedMs of [NaN, Infinity, -1, '12000', undefined]) assert.strictEqual(tick(running, elapsedMs), running);
});

test('open, closed and merged PRs replay locally without changing real metadata or copying release authority', () => {
  for (const status of [{ state: 'open', merged: false }, { state: 'closed', merged: false }, { state: 'closed', merged: true }]) {
    const pr = freezeDeep(sourcePull(status)), before = JSON.stringify(pr);
    let state = createReplayState({ sessionId: `source-${status.state}-${status.merged}`, pr });
    assert.deepEqual(Object.keys(state.pr).sort(), ['baseBranch', 'files', 'filesUnavailableReason', 'headSha', 'number', 'title']);
    assert.equal(state.pr.number, pr.number); assert.equal(state.pr.headSha, pr.headSha);
    assert.notStrictEqual(state.pr.files, pr.files); assert.notStrictEqual(state.pr.files[0], pr.files[0]);
    assert.equal(state.pr.files[0].url, undefined);
    state = tick(begin(state), REPLAY_DURATION_MS);
    state = replayReducer(state, { type: 'RESET', sessionId: 'next-local-cycle' });
    assert.equal(JSON.stringify(pr), before);
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes('real-saved-run') && !serialized.includes('mergeEligibility') && !serialized.includes('https://'));
  }
});

test('historical file unavailability remains visible without inventing a replay file list', () => {
  const state = createReplayState({ sessionId: 'unavailable', pr: sourcePull({ state: 'closed', files: [], filesUnavailableReason: 'The historical file list could not be loaded.' }) });
  assert.deepEqual(state.pr.files, []); assert.equal(state.pr.filesUnavailableReason, 'The historical file list could not be loaded.');
});

test('the replay clock cancels on exit and queued callbacks cannot emit after cancellation', () => {
  let time = 1000, callback; const events = [], cancelled = [], timerId = Symbol('timer');
  const stop = startReplayClock({ sessionId: 'timer-session', onTick: event => events.push(event), now: () => time, schedule: fn => { callback = fn; return timerId; }, cancel: id => cancelled.push(id) });
  time += 500; callback(); assert.deepEqual(events, [{ type: 'TICK', sessionId: 'timer-session', elapsedMs: 500 }]);
  stop(); stop(); time += REPLAY_DURATION_MS; callback();
  assert.equal(events.length, 1); assert.deepEqual(cancelled, [timerId]);
});

test('the replay clock stops at completion and old-session ticks cannot complete a new replay', () => {
  let time = 0, callback, state = begin(createReplayState({ sessionId: 'old-clock', pr: sourcePull() })); const cancelled = [];
  startReplayClock({ sessionId: 'old-clock', onTick: event => { state = replayReducer(state, event); }, now: () => time, schedule: fn => { callback = fn; return 1; }, cancel: id => cancelled.push(id) });
  state = begin(replayReducer(state, { type: 'RESET', sessionId: 'new-clock' }));
  time = REPLAY_DURATION_MS; callback();
  assert.equal(state.sessionId, 'new-clock'); assert.equal(state.phase, 'running'); assert.equal(state.elapsedMs, 0); assert.deepEqual(cancelled, [1]);
  callback(); assert.equal(state.elapsedMs, 0); assert.deepEqual(cancelled, [1]);
});

test('the presentation component has no API transport dependency or release mutation endpoint', async () => {
  const component = await fs.readFile(new URL('../../client/PresentationReplay.jsx', import.meta.url), 'utf8');
  const model = await fs.readFile(new URL('../../client/replay-state.js', import.meta.url), 'utf8');
  const imports = [...component.matchAll(/^import\s+[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/gm)].map(match => match[1]);
  assert.ok(imports.length > 0); assert.ok(imports.every(specifier => ['react', './replay-state.js'].includes(specifier)), `Unexpected replay dependency: ${imports.join(', ')}`);
  for (const source of [component, model]) {
    assert.doesNotMatch(source, /\b(?:fetch|request|sendBeacon|XMLHttpRequest|WebSocket)\s*\(/);
    assert.doesNotMatch(source, /['"`]\/api\//);
    assert.doesNotMatch(source, /\bimport\s*\(/);
  }
});
