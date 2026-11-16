import React, { useEffect, useId, useReducer, useState } from 'react';
import { createReplayState, replayReducer, REPLAY_DURATION_MS, REPLAY_ROLES, startReplayClock } from './replay-state.js';

function ReplayStatus({ status, children }) {
  const tone = ['passed', 'completed'].includes(status) ? 'good' : ['running', 'in_progress'].includes(status) ? 'active' : 'neutral';
  return <span className={`status status--${tone}`}><span aria-hidden="true" />{children}</span>;
}

export default function PresentationReplay({ source, onExit, onPhaseChange }) {
  const [replay, dispatch] = useReducer(replayReducer, source, pr => {
    const state = createReplayState({ sessionId: crypto.randomUUID(), pr });
    return replayReducer(state, { type: 'START', sessionId: state.sessionId });
  });
  const [expandedFiles, setExpandedFiles] = useState(false);
  const headingId = useId();
  useEffect(() => {
    if (replay.phase !== 'running') return;
    return startReplayClock({ sessionId: replay.sessionId, onTick: dispatch });
  }, [replay.sessionId, replay.phase]);
  useEffect(() => { onPhaseChange?.(replay.phase); }, [replay.phase, onPhaseChange]);

  const running = replay.phase === 'running';
  const passed = replay.phase === 'passed';
  const completed = replay.reviews.filter(review => review.status === 'completed').length + (passed ? 1 : 0);
  const currentReviewer = replay.reviews.find(review => review.status === 'running');
  const stage = currentReviewer ? `${REPLAY_ROLES.find(role => role.role === currentReviewer.role).title} review in progress` : running ? 'CI checks in progress' : 'Checks complete';
  const visibleFiles = expandedFiles ? replay.pr.files : replay.pr.files.slice(0, 6);

  return <section className="presentation-replay" aria-labelledby={headingId}>
    <div className="replay-toolbar">
      <div><h3 id={headingId}>Checks</h3><p className="muted">Security, correctness, maintainability and CI.</p></div>
      <div className="release-actions"><button className="button button--primary" autoFocus onClick={() => dispatch({ type: 'RESTART', sessionId: crypto.randomUUID() })}>Test again</button><button className="button" onClick={onExit}>Back to pull request</button></div>
    </div>
    <section className="run-progress replay-progress" aria-label="Test progress">
      <div className="section-heading"><strong role="status">{stage}</strong><ReplayStatus status={replay.phase}>{passed ? 'Complete' : 'Testing'}</ReplayStatus></div>
      <p>{completed} of 4 checks complete</p>
      <div className="replay-progress-track" aria-hidden="true"><span style={{ width: `${replay.elapsedMs / REPLAY_DURATION_MS * 100}%` }} /></div>
      <ol>{[...REPLAY_ROLES.map(role => ({ ...role, status: replay.reviews.find(review => review.role === role.role).status })), { role: 'ci', title: 'CI checks', status: replay.ci.status }].map(step => <li key={step.role} data-state={step.status}><span className="step-mark" aria-hidden="true" /><span><strong>{step.title}</strong><span>{step.status === 'completed' ? 'Complete' : ['running', 'in_progress'].includes(step.status) ? 'In progress' : 'Waiting'}</span></span></li>)}</ol>
    </section>
    <div className="evidence-grid">
      <section className="evidence-section" aria-labelledby={`${headingId}-reviews`}><div className="section-heading"><h3 id={`${headingId}-reviews`}>Agent reviews</h3><span className="muted">3 checks</span></div><div className="reviews">{REPLAY_ROLES.map(role => {
        const review = replay.reviews.find(item => item.role === role.role);
        return <details key={`${replay.sessionId}-${role.role}`} className={`review ${review.status === 'running' ? 'review--running' : ''}`} aria-busy={review.status === 'running'}><summary><div><h4>{role.title}</h4><span className="subline">{role.description}</span></div><ReplayStatus status={review.status}>{review.status === 'completed' ? 'Complete' : review.status === 'running' ? 'In progress' : 'Not started'}</ReplayStatus><span className="disclosure-mark" aria-hidden="true">⌄</span></summary><div className="review-body"><p>{review.status === 'completed' ? `${role.title} stage complete.` : review.status === 'running' ? `${role.title} stage in progress.` : 'Waiting for this check to start.'}</p></div></details>;
      })}</div></section>
      <section className="evidence-section ci-section" aria-labelledby={`${headingId}-ci`}><div className="section-heading"><h3 id={`${headingId}-ci`}>CI checks</h3><ReplayStatus status={replay.ci.status}>{passed ? 'Complete' : replay.ci.status === 'in_progress' ? 'In progress' : 'Not started'}</ReplayStatus></div><p>{passed ? 'All four stages are complete.' : replay.ci.status === 'in_progress' ? 'Completing the final check.' : 'Waiting for the review stages to finish.'}</p></section>
    </div>
    <div className="bottom-grid">
      <section className="evidence-section files-section" aria-labelledby={`${headingId}-files`}><div className="section-heading"><h3 id={`${headingId}-files`}>Changed files</h3><span className="muted">{replay.pr.files.length} files</span></div>{replay.pr.filesUnavailableReason ? <p className="empty-line">{replay.pr.filesUnavailableReason}</p> : !visibleFiles.length ? <p className="empty-line">No changed files were returned for this pull request.</p> : <><ul className="file-list">{visibleFiles.map(file => <li key={file.path}><div><code>{file.path}</code><span className="subline">{file.status || 'Changed'}</span></div><div className="file-diff"><span aria-label={`${file.additions ?? 0} additions`}>+{file.additions ?? '—'}</span><span aria-label={`${file.deletions ?? 0} deletions`}>−{file.deletions ?? '—'}</span></div></li>)}</ul>{replay.pr.files.length > 6 && <button className="text-button expand-files" onClick={() => setExpandedFiles(!expandedFiles)}>{expandedFiles ? 'Show fewer files' : `Show all ${replay.pr.files.length} files`}</button>}</>}</section>
    </div>
  </section>;
}
