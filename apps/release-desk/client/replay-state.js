export const REPLAY_DURATION_MS = 12000;
export const REPLAY_ROLES = [
  { role: 'security', title: 'Security', description: 'Permissions, secrets and unsafe changes' },
  { role: 'correctness', title: 'Correctness', description: 'Behavior, edge cases and regressions' },
  { role: 'maintainability', title: 'Maintainability', description: 'Clarity, structure and future changes' },
];

// Deliberately copy only presentation context, never saved runs or merge evidence.
export function createReplayState({ sessionId, pr }) {
  return {
    sessionId,
    pr: {
      number: pr.number,
      title: pr.title,
      headSha: pr.headSha,
      baseBranch: pr.baseBranch,
      files: (pr.files || []).map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
      filesUnavailableReason: pr.filesUnavailableReason || null,
    },
    phase: 'idle',
    elapsedMs: 0,
    reviews: REPLAY_ROLES.map(({ role }) => ({ role, status: 'pending', verdict: null, simulated: true })),
    ci: { status: 'pending', conclusion: null, simulated: true },
  };
}

function progress(state, elapsedMs) {
  const ends = [3500, 6500, 9500];
  const starts = [0, 3500, 6500];
  return {
    ...state,
    elapsedMs,
    phase: elapsedMs >= REPLAY_DURATION_MS ? 'passed' : 'running',
    reviews: state.reviews.map((review, index) => ({
      ...review,
      status: elapsedMs >= ends[index] ? 'completed' : elapsedMs >= starts[index] ? 'running' : 'pending',
      verdict: elapsedMs >= ends[index] ? 'approve' : null,
    })),
    ci: {
      status: elapsedMs >= REPLAY_DURATION_MS ? 'completed' : elapsedMs >= ends[2] ? 'in_progress' : 'pending',
      conclusion: elapsedMs >= REPLAY_DURATION_MS ? 'success' : null,
      simulated: true,
    },
  };
}

export function replayReducer(state, event) {
  if (event.type === 'RESTART') {
    if (!event.sessionId || event.sessionId === state.sessionId) return state;
    return progress(createReplayState({ sessionId: event.sessionId, pr: state.pr }), 0);
  }
  if (event.type === 'RESET') {
    if (!event.sessionId || event.sessionId === state.sessionId) return state;
    return createReplayState({ sessionId: event.sessionId, pr: state.pr });
  }
  if (event.sessionId !== state.sessionId) return state;
  if (event.type === 'START' && state.phase === 'idle') return progress(state, 0);
  if (event.type === 'TICK' && state.phase === 'running' && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0) {
    return progress(state, Math.min(REPLAY_DURATION_MS, Math.max(state.elapsedMs, event.elapsedMs)));
  }
  return state;
}

// Injectable clock keeps cleanup testable without a browser or external requests.
export function startReplayClock({ sessionId, onTick, now = () => performance.now(), schedule = setInterval, cancel = clearInterval }) {
  const startedAt = now();
  let stopped = false;
  const timer = schedule(() => {
    if (stopped) return;
    const elapsedMs = Math.max(0, now() - startedAt);
    onTick({ type: 'TICK', sessionId, elapsedMs });
    if (elapsedMs >= REPLAY_DURATION_MS) stop();
  }, 150);
  function stop() {
    if (stopped) return;
    stopped = true;
    cancel(timer);
  }
  return stop;
}
