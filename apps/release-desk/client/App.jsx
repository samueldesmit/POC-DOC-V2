import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, externalUrl, fixtureEnabled, request } from './api.js';
import PresentationReplay from './PresentationReplay.jsx';
import StorePreviews from './StorePreviews.jsx';
import ClaudeConnections from './ClaudeConnections.jsx';

const roles = [
  ['security', 'Security', 'Permissions, secrets and unsafe changes'],
  ['correctness', 'Correctness', 'Behavior, edge cases and regressions'],
  ['maintainability', 'Maintainability', 'Clarity, structure and future changes'],
];
const busyStates = new Set(['queued', 'running', 'merging', 'merge_unknown']);
const statusLabels = { queued: 'Queued', running: 'Testing', passed: 'Passed', failed: 'Needs attention', stale: 'Out of date', merged: 'Merged', closed: 'Closed', merging: 'Merging', merge_unknown: 'Merge unconfirmed', pending: 'Not started', completed: 'Complete', in_progress: 'Running', error: 'Error', success: 'Passed', failure: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', untested: 'Not tested', not_recorded: 'Not recorded' };
const shortSha = value => value ? value.slice(0, 8) : '—';
const message = value => typeof value === 'string' ? value : value?.message || 'The request could not be completed.';
const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';

function inboxStatus(pull) {
  if (pull.state === 'closed') return pull.merged ? 'merged' : 'closed';
  const review = pull.latestRun;
  if (review && (review.headSha !== pull.headSha || (review.baseSha && pull.baseSha && review.baseSha !== pull.baseSha) || review.status === 'stale')) return 'stale';
  return review?.status || 'untested';
}

function Status({ value = 'untested', children }) {
  const tone = ['passed', 'success', 'merged', 'approve'].includes(value) ? 'good' : ['failed', 'failure', 'error', 'request_changes'].includes(value) ? 'bad' : ['stale', 'merge_unknown', 'cancelled', 'timed_out'].includes(value) ? 'warning' : ['running', 'in_progress', 'queued', 'merging'].includes(value) ? 'active' : 'neutral';
  return <span className={`status status--${tone}`}><span aria-hidden="true" />{children || statusLabels[value] || value}</span>;
}

function ExternalLink({ href, children, className }) {
  const safe = externalUrl(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" className={className}>{children}<span className="external-mark" aria-hidden="true">↗</span></a> : <span className={className}>{children}</span>;
}

function ReleaseBar({ release, branches, canRelease, busy, onOpen, onCreate }) {
  const staging = branches?.staging || 'staging', live = branches?.live || 'main';
  if (release.openPull) return <div className="page-notice"><Notice title="Release ready for review" tone="neutral" action={<button className="button" onClick={() => onOpen(release.openPull)}>Open release #{release.openPull}</button>}>{`Pull request #${release.openPull} takes ${staging} live. Test it, check the staging preview, then release it.`}</Notice></div>;
  if (!release.aheadBy) return <div className="page-notice"><Notice title="Live is up to date" tone="good">{`Everything merged into ${staging} is live on ${live}.`}</Notice></div>;
  return <div className="page-notice"><Notice title={`${release.aheadBy} change${release.aheadBy === 1 ? '' : 's'} on ${staging} not live yet`} tone="warning" action={<button className="button button--primary" disabled={!canRelease} onClick={onCreate}>{busy ? 'Preparing…' : 'Prepare release'}</button>}>{`Test the changes on the staging theme. When they are right, prepare a release: it opens one pull request from ${staging} into ${live}.`}</Notice></div>;
}

function Notice({ title, children, tone = 'neutral', action }) {
  return <div className={`notice notice--${tone}`}><div><strong>{title}</strong>{children && <div>{children}</div>}</div>{action}</div>;
}

function Commit({ sha, label }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);
  return <span className="commit"><code title={sha || undefined}>{shortSha(sha)}</code>{sha && <button className="copy-button" aria-label={`Copy ${label || 'commit'} ${sha}`} onClick={async () => { try { await navigator.clipboard.writeText(sha); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy'}</button>}</span>;
}

function Review({ role, title, description, review, simulated }) {
  const state = review?.status || 'pending';
  const label = state === 'completed' ? review?.verdict === 'approve' ? simulated ? 'Complete' : 'Approved' : review?.verdict === 'request_changes' ? 'Changes requested' : 'No verdict' : state === 'running' && simulated ? 'In progress' : statusLabels[state] || state;
  const findings = review?.findings || [];
  return <details className={`review ${state === 'running' ? 'review--running' : ''}`} aria-busy={state === 'running'} open={state === 'error' || review?.verdict === 'request_changes'}>
    <summary><div><h4>{title}</h4><span className="subline">{description}</span></div><Status value={state === 'completed' ? review.verdict || 'pending' : state}>{label}</Status><span className="disclosure-mark" aria-hidden="true">⌄</span></summary>
    <div className="review-body"><p>{simulated && state !== 'error' ? state === 'completed' ? `${title} stage complete.` : state === 'running' ? `${title} stage in progress.` : 'Waiting for this check to start.' : review?.summary || (state === 'pending' ? 'This agent has not returned a review yet.' : state === 'running' ? 'The agent is reviewing the tested commit.' : 'No review summary was returned.')}</p>
      {findings.length > 0 && <ul className="findings">{findings.map((finding, index) => <li key={`${role}-${index}`}><div className="finding-location"><span className="severity">{finding.severity || 'Finding'}</span>{finding.path && <code>{finding.path}{finding.line ? `:${finding.line}` : ''}</code>}</div><p>{finding.message}</p></li>)}</ul>}
      {state === 'completed' && !findings.length && !simulated && <p className="muted">No findings reported.</p>}
    </div>
  </details>;
}

function RunProgress({ run }) {
  const steps = roles.map(([role, title]) => ({ title, status: run?.reviews?.find(review => review.role === role)?.status || 'pending' }));
  steps.push({ title: 'GitHub CI', status: run?.ci?.status || 'pending', actual: true });
  const labels = { queued: 'Queued', pending: 'Waiting', running: 'In progress', in_progress: 'Running', completed: 'Complete', error: 'Error' };
  const stageLabels = { demo_reviewing: 'Review stages in progress', waiting_for_ci: 'Waiting for GitHub CI', waiting_for_github: 'GitHub is temporarily unavailable. The current test will resume shortly.', queued: 'Preparing the test run' };
  return <section className="run-progress" aria-label="Test run progress">
    <div className="section-heading"><strong>Checks in progress</strong><span className="muted">{steps.filter(step => step.status === 'completed').length} of 4 stages complete</span></div>
    <p role="status">{stageLabels[run?.stage] || run?.stage || 'Preparing reviewers and CI checks.'}</p>
    <ol>{steps.map(step => <li key={step.title} data-state={step.status}><span className="step-mark" aria-hidden="true" /><span><strong>{step.title}</strong><span>{labels[step.status] || step.status}</span></span></li>)}</ol>
    <p className="progress-note">The job continues in the background. Use Refresh to load the latest results.</p>
  </section>;
}

function MergeDialog({ target, currentPull, eligible, checking, deployment, busy, error, onClose, onMerge }) {
  const dialog = useRef(null);
  const unchanged = currentPull?.headSha === target.headSha && currentPull?.number === target.number;
  useEffect(() => { const element = dialog.current; element.showModal(); return () => { if (element.open) element.close(); }; }, []);
  return <dialog ref={dialog} className="merge-dialog" aria-labelledby="merge-title" aria-describedby="merge-description" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading"><h2 id="merge-title">Merge to {target.baseBranch}</h2><button className="icon-button" aria-label="Close merge confirmation" disabled={busy} onClick={onClose}>×</button></div>
    <p id="merge-description">Merge this tested commit into the shared theme repository.</p>
    <div className="merge-object"><strong>#{target.number} · {target.title}</strong><dl><div><dt>Commit</dt><dd><code>{target.headSha}</code></dd></div><div><dt>Destination</dt><dd>{target.baseBranch}</dd></div><div><dt>Review run</dt><dd><code>{target.runId}</code></dd></div></dl></div>
    <p className="deployment-note">{deployment}</p>
    {!unchanged && <Notice title="The pull request changed" tone="warning">Close this confirmation and test the current commit before merging.</Notice>}
    {unchanged && checking && !busy && <p className="muted" role="status">Refreshing current-commit evidence…</p>}
    {unchanged && !checking && !eligible && <Notice title="Merge is no longer ready" tone="warning">The latest server check no longer permits this merge. Close and review the updated evidence.</Notice>}
    {error && <Notice title="Merge could not be confirmed" tone="warning">{error.message}</Notice>}
    <div className="dialog-actions"><button className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button button--primary" disabled={busy || !unchanged || !eligible} onClick={() => onMerge(target)}>{busy ? 'Merging…' : `Merge to ${target.baseBranch}`}</button></div>
  </dialog>;
}

function Files({ files, loading, error, unavailableReason }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? files : files.slice(0, 6);
  return <section className="evidence-section files-section" aria-labelledby="files-heading"><div className="section-heading"><h3 id="files-heading">Changed files</h3>{!loading && !error && !unavailableReason && <span className="muted">{files.length} {files.length === 1 ? 'file' : 'files'}</span>}</div>
    {loading ? <p className="empty-line" role="status">Loading changed files…</p> : error ? <p className="empty-line">Changed files could not be loaded.</p> : unavailableReason ? <p className="empty-line">{unavailableReason}</p> : files.length === 0 ? <p className="empty-line">No changed files were returned for this pull request.</p> : <><ul className="file-list">{visible.map(file => <li key={file.path}><div><ExternalLink href={file.url}><code>{file.path}</code></ExternalLink><span className="subline">{file.status || 'Changed'}</span></div><div className="file-diff"><span aria-label={`${file.additions ?? 0} additions`}>+{file.additions ?? '—'}</span><span aria-label={`${file.deletions ?? 0} deletions`}>−{file.deletions ?? '—'}</span></div></li>)}</ul>{files.length > 6 && <button className="text-button expand-files" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer files' : `Show all ${files.length} files`}</button>}</>}
  </section>;
}

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [dashboardError, setDashboardError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState(null);
  const [inboxView, setInboxView] = useState('open');
  const [showConnections, setShowConnections] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const [historyRun, setHistoryRun] = useState('');
  const [liveRun, setLiveRun] = useState(null);
  const [action, setAction] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [success, setSuccess] = useState('');
  const [mergeTarget, setMergeTarget] = useState(null);
  const [replay, setReplay] = useState(null);
  const [replayPhase, setReplayPhase] = useState('running');
  const replayRef = useRef(null);
  const polling = useRef(false);
  const mounted = useRef(true);
  const detailHeading = useRef(null);
  const mergeButton = useRef(null);

  const refresh = useCallback(async () => {
    if (polling.current || replayRef.current) return;
    polling.current = true; setRefreshing(true);
    try {
      const result = await request('/api/dashboard');
      if (result.setup?.blockers?.some(blocker => blocker.code === 'GITHUB_UNAVAILABLE')) throw new ApiError('GitHub is temporarily unavailable. Your last loaded data is still shown. Use Refresh to try again.', 'GITHUB_UNAVAILABLE', 503);
      if (mounted.current) {
        setDashboard(previous => ({ ...result, history: result.historyError && previous ? previous.history : result.history }));
        setDashboardError(null);
        setDetailVersion(value => value + 1);
      }
    }
    catch (error) { if (mounted.current) setDashboardError(error); }
    finally { polling.current = false; if (mounted.current) setRefreshing(false); }
  }, []);

  const exitReplay = useCallback(({ restoreFocus = true } = {}) => {
    if (!replayRef.current) return;
    replayRef.current = null;
    setReplay(null);
    refresh();
    if (restoreFocus) requestAnimationFrame(() => detailHeading.current?.focus());
  }, [refresh]);

  useEffect(() => {
    mounted.current = true; refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  const pulls = dashboard?.pulls || [];
  const historyPulls = dashboard?.history || [];
  const allPulls = [...pulls, ...historyPulls];
  const visiblePulls = inboxView === 'history' ? historyPulls : pulls;
  useEffect(() => {
    if (!dashboard) return;
    const current = allPulls.find(pull => pull.number === selected);
    if (current) {
      // Keep the selected PR visible when a live merge moves it into History.
      const nextView = current.state === 'closed' ? 'history' : 'open';
      if (nextView !== inboxView) setInboxView(nextView);
    } else {
      setSelected(visiblePulls[0]?.number ?? null); setMobileDetail(false);
    }
  }, [dashboard, selected, inboxView]);
  const listedPull = allPulls.find(pull => pull.number === selected);
  const latestDashboardRun = listedPull?.latestRun || dashboard?.runs?.find(run => run.prNumber === selected);

  useEffect(() => { setActionError(null); setHistoryRun(''); }, [selected]);
  useEffect(() => { if (replayRef.current && replayRef.current.number !== selected) exitReplay({ restoreFocus: false }); }, [selected, exitReplay]);
  useEffect(() => {
    if (replay || refreshing || dashboardError) return;
    if (!selected) { setDetail(null); return; }
    const controller = new AbortController();
    setDetailLoading(true); setDetailError(null);
    request(`/api/pulls/${selected}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setDetail(result); }).catch(error => { if (error.name !== 'AbortError' && !controller.signal.aborted) setDetailError(error); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, listedPull?.headSha, listedPull?.baseSha, listedPull?.state, listedPull?.merged, detailVersion, replay, refreshing, dashboardError]);

  const detailMatches = detail?.pull?.number === selected && detail?.pull?.headSha === listedPull?.headSha && detail?.pull?.state === listedPull?.state && detail?.pull?.merged === listedPull?.merged && (!listedPull?.baseSha || detail?.pull?.baseSha === listedPull.baseSha);
  // The selected-detail route resolves GitHub's computed mergeability. The inbox
  // intentionally remains conservative and must not overwrite that evidence.
  const pull = detailMatches ? { ...listedPull, ...detail.pull } : listedPull;
  const closedPull = pull?.state === 'closed';
  const mergedPull = pull?.merged === true;
  useEffect(() => { if (closedPull) setMergeTarget(null); }, [closedPull]);
  const runs = detailMatches ? detail.runs || [] : [];
  const run = [...runs, latestDashboardRun, liveRun].filter(item => item?.prNumber === selected).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0) || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
  const displayedRun = historyRun && historyRun !== run?.id ? runs.find(item => item.id === historyRun) || run : run;
  const demoMode = dashboard?.reviewMode === 'demo';
  const isDemoRun = item => item ? item.reviewMode === 'demo' || item.reviews?.some(review => review.simulated === true) : demoMode;
  const currentDemo = isDemoRun(run);
  const displayedDemo = displayedRun ? isDemoRun(displayedRun) : !closedPull && demoMode;

  // Saved checks update only after an explicit Refresh or release action.
  const stale = !closedPull && !!run && (run.headSha !== pull?.headSha || (!!run.baseSha && !!pull?.baseSha && run.baseSha !== pull.baseSha) || run.status === 'stale');
  const state = closedPull ? mergedPull ? 'merged' : 'closed' : stale ? 'stale' : run?.status || 'untested';
  const active = !closedPull && busyStates.has(run?.status);
  const configReady = dashboard?.setup?.ready === true;
  const githubConnectionPending = dashboard?.setup?.blockers?.some(blocker => ['GITHUB_AUTH_MISSING', 'GITHUB_UNAVAILABLE'].includes(blocker.code)) === true;
  const sessionRefreshNeeded = dashboardError?.status === 401 || ['SHOPIFY_SESSION_REQUIRED', 'INVALID_SESSION', 'UNAUTHENTICATED'].includes(dashboardError?.code);
  const canMutate = dashboard?.actor?.canMutate === true;
  const evidenceReady = !closedPull && !!run && run.status === 'passed' && !stale && pull?.mergeEligibility?.allowed === true;
  const safeCurrentView = !!detailMatches && !refreshing && !detailLoading && !detailError && !dashboardError;
  const mayTest = !replay && configReady && canMutate && safeCurrentView && !!pull && !pull.draft && pull.state === 'open' && !active && !action;
  const mayMerge = !replay && evidenceReady && safeCurrentView && canMutate && configReady && !action;
  const mayReplay = safeCurrentView && !!pull && !active && !action && !mergeTarget && !refreshing;
  const deployment = dashboard?.deployment?.description || 'Changes go into staging first; releasing merges staging into the live branch.';
  const filteredPulls = useMemo(() => visiblePulls.filter(item => `${item.number} ${item.title} ${typeof item.author === 'string' ? item.author : item.author?.login || ''}`.toLowerCase().includes(query.toLowerCase())), [dashboard, inboxView, query]);

  const chooseView = view => {
    exitReplay({ restoreFocus: false });
    setInboxView(view); setQuery(''); setMobileDetail(false);
    setSelected((view === 'history' ? historyPulls : pulls)[0]?.number ?? null);
  };
  const onTabKey = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const view = event.key === 'Home' ? 'open' : event.key === 'End' ? 'history' : inboxView === 'open' ? 'history' : 'open';
    chooseView(view); document.getElementById(`inbox-tab-${view}`)?.focus();
  };
  const choosePull = number => { exitReplay({ restoreFocus: false }); setInboxView(historyPulls.some(item => item.number === number) ? 'history' : 'open'); setSelected(number); setQuery(''); setMobileDetail(true); setSuccess(''); setTimeout(() => detailHeading.current?.focus(), 0); };
  const enterReplay = () => {
    if (replayRef.current || polling.current || !mayReplay) return;
    const source = { number: pull.number, title: pull.title, headSha: pull.headSha, baseBranch: pull.baseBranch, files: detail.files || [], filesUnavailableReason: detail.filesUnavailableReason };
    replayRef.current = source;
    setReplayPhase('running');
    setReplay(source);
    setMergeTarget(null);
    setActionError(null);
    setSuccess('');
  };
  const testChanges = async () => {
    if (replayRef.current || !mayTest) return;
    const target = { number: pull.number, headSha: pull.headSha };
    setAction('test'); setActionError(null); setSuccess('');
    try { const result = await request(`/api/pulls/${target.number}/test`, { method: 'POST', body: { headSha: target.headSha } }); setLiveRun(result.run); await refresh(); }
    catch (error) { setActionError(error); await refresh(); }
    finally { setAction(null); }
  };
  const reconcile = async () => {
    if (replayRef.current || run?.status !== 'merge_unknown' || !canMutate || !safeCurrentView || action) return;
    setAction('reconcile'); setActionError(null); setSuccess('');
    try {
      await request(`/api/pulls/${pull.number}/reconcile`, { method: 'POST', body: { runId: run.id } });
      await refresh();
    } catch (error) { setActionError(error); await refresh(); }
    finally { setAction(null); }
  };
  const createRelease = async () => {
    if (replayRef.current || !canMutate || action) return;
    setAction('release'); setActionError(null); setSuccess('');
    try {
      const result = await request('/api/release', { method: 'POST', body: {} });
      await refresh(); setInboxView('open'); choosePull(result.number);
    } catch (error) { setActionError(error); await refresh(); }
    finally { setAction(null); }
  };
  const merge = async target => {
    if (replayRef.current || !mayMerge || pull.headSha !== target.headSha || run.id !== target.runId) return;
    setAction('merge'); setActionError(null);
    try {
      await request(`/api/pulls/${target.number}/merge`, { method: 'POST', body: { headSha: target.headSha, runId: target.runId } });
      setMergeTarget(null); setSuccess(`Pull request #${target.number} merged to ${target.baseBranch}. ${deployment}`); await refresh();
    } catch (error) { setActionError(error); await refresh(); }
    finally { setAction(null); }
  };

  return <div className="release-app" data-ui>
    {fixtureEnabled && <div className="fixture-notice"><strong>Development fixture</strong><span>Illustrative data. No Shopify or GitHub actions.</span><label>State <select defaultValue={new URLSearchParams(location.search).get('state') || 'ready'} onChange={event => { const url = new URL(location.href); url.searchParams.set('state', event.target.value); location.assign(url); }}>{['ready', 'untested', 'running', 'demo', 'history', 'failed', 'stale', 'setup', 'empty', 'error', 'readonly', 'merge_unknown'].map(value => <option key={value}>{value}</option>)}</select></label></div>}
    <header className="app-heading"><div className="product-heading"><h1>Release Desk</h1><span className="scope">{dashboard?.shop || 'Shopify store'}</span></div><div className="refresh-control"><span>{dashboard ? `Updated ${date(dashboard.updatedAt)}` : 'Shopify embedded app'}</span><button className="button" onClick={() => setShowConnections(value => !value)} disabled={!dashboard} aria-expanded={showConnections}>Connect Claude</button><button className="button" onClick={refresh} disabled={refreshing || !!replay}>{refreshing ? 'Refreshing…' : 'Refresh'}</button></div></header>
    {!dashboard ? <main className="initial-state"><section className="sheet setup-sheet"><h2>{dashboardError ? dashboardError.code === 'SHOPIFY_SESSION_REQUIRED' ? 'Shopify session required' : 'Could not connect to Release Desk' : 'Connecting to Release Desk'}</h2><p role="status">{dashboardError ? dashboardError.message : 'Verifying your Shopify session and loading the repository.'}</p>{dashboardError && <button className="button" onClick={refresh}>Try again</button>}<div className="initial-context"><span>Repository</span><strong>Theme repository</strong><span>Release controls</span><strong>Reviewer results, CI, then manual merge</strong></div></section></main> : <main>
      {success && <div className="page-notice" role="status"><Notice title="Merge completed" tone="good">{success}</Notice></div>}
      {dashboardError && <div className="page-notice"><Notice title="Could not refresh release data" tone="warning" action={<button className="text-button" onClick={refresh}>Retry</button>}>{dashboardError.message} Last successful update: {date(dashboard.updatedAt)}. Release actions are paused until the data refreshes.</Notice></div>}
      {!configReady && <div className="page-notice"><Notice title="Complete the release service setup" tone="warning"><ul>{(dashboard.setup?.blockers || []).map((blocker, index) => <li key={blocker.code || index}>{message(blocker)}</li>)}</ul>{!dashboard.setup?.blockers?.length && <p>The server is not ready to run reviews or merge changes.</p>}</Notice></div>}
      {!canMutate && <div className="page-notice"><Notice title="Read-only access">Your Shopify account can inspect reports. A configured release reviewer must start tests and merge changes.</Notice></div>}
      {showConnections && <div className="page-notice"><ClaudeConnections canCreate={canMutate} onClose={() => setShowConnections(false)} /></div>}
      {dashboard.release && <ReleaseBar release={dashboard.release} branches={dashboard.branches} canRelease={canMutate && configReady && !action && !replay} busy={action === 'release'} onOpen={number => { setInboxView('open'); choosePull(number); }} onCreate={createRelease} />}
      <div className={`workspace sheet ${mobileDetail ? 'workspace--detail' : ''}`}>
        <aside className="inbox" aria-label="Pull request inbox"><div className="inbox-heading"><h2>Pull requests</h2><ExternalLink href={`https://github.com/${dashboard.repository}/pulls`}>GitHub</ExternalLink></div>
          <div className="inbox-tabs" role="tablist" aria-label="Pull request views">{[['open', 'Open', pulls.length], ['history', 'History', dashboard.historyError ? '—' : historyPulls.length]].map(([view, label, count]) => <button key={view} id={`inbox-tab-${view}`} type="button" role="tab" aria-selected={inboxView === view} aria-controls="inbox-results" tabIndex={inboxView === view ? 0 : -1} onClick={() => chooseView(view)} onKeyDown={onTabKey}>{label}<span className="count">{count}</span></button>)}</div>
          <div id="inbox-results" role="tabpanel" aria-labelledby={`inbox-tab-${inboxView}`}><div className="inbox-search"><label className="sr-only" htmlFor="pr-search">Search pull requests</label><input id="pr-search" type="search" placeholder="Find a pull request" value={query} onChange={event => setQuery(event.target.value)} /></div>
          <ul className="pull-list">{filteredPulls.map(item => <li key={item.number}><button className={`pull-row ${selected === item.number ? 'is-selected' : ''}`} onClick={() => choosePull(item.number)} aria-current={selected === item.number ? 'true' : undefined}><span className="pull-number">#{item.number}<span>{item.draft ? 'Draft' : item.stage === 'live' ? 'Release to live' : `Into ${item.baseBranch}`}</span></span><strong>{item.title}</strong><span className="pull-meta"><Status value={replay && item.number === replay.number ? replayPhase : inboxStatus(item)} /><span>{item.requestedBy ? `${item.requestedBy} via Claude` : typeof item.author === 'string' ? item.author : item.author?.login || 'Unknown author'}</span></span>{item.state === 'closed' && <span className="pull-closed-at">{item.merged ? 'Merged' : 'Closed'} {date(item.merged ? item.mergedAt : item.closedAt)}</span>}</button></li>)}</ul>
          {inboxView === 'history' && dashboard.historyError && <div className="history-load-error"><Notice title="Could not load history" tone="warning" action={<button className="text-button" onClick={refresh}>Retry</button>}>{dashboard.historyError}</Notice></div>}
          {!filteredPulls.length && !(inboxView === 'history' && dashboard.historyError) && <div className="inbox-empty"><strong>{githubConnectionPending ? 'GitHub connection pending' : query ? 'No matching pull requests' : inboxView === 'history' ? 'No pull request history yet' : 'No open pull requests'}</strong><p>{githubConnectionPending ? 'Finish the GitHub connection to load pull requests.' : query ? 'Try another title, number or author.' : inboxView === 'history' ? 'Merged and closed pull requests will appear here.' : 'New pull requests for the shared theme will appear here.'}</p></div>}
          {inboxView === 'history' && historyPulls.length > 0 && <p className="history-limit">Recent merged and closed pull requests · up to 50</p>}</div>
          <section className="activity" aria-labelledby="activity-title"><div className="section-heading"><h3 id="activity-title">Notifications</h3><span className="muted">Latest</span></div>{dashboard.notifications?.length ? <ul>{dashboard.notifications.slice(0, 4).map(notification => <li key={notification.id}><button onClick={() => notification.prNumber && choosePull(notification.prNumber)} disabled={!allPulls.some(item => item.number === notification.prNumber)}><span>{notification.title}</span><span className="subline">{notification.prNumber ? `#${notification.prNumber} · ` : ''}{date(notification.createdAt)}</span></button></li>)}</ul> : <p className="empty-line">No release notifications yet.</p>}</section>
        </aside>
        <article className="detail" aria-label="Selected pull request"><button className="text-button mobile-back" onClick={() => setMobileDetail(false)}>← {inboxView === 'history' ? 'History' : 'Pull requests'}</button>
          {!pull ? <div className="no-selection"><h2>{githubConnectionPending ? 'GitHub connection pending' : inboxView === 'history' && dashboard.historyError ? 'History unavailable' : visiblePulls.length ? 'Select a pull request' : inboxView === 'history' ? 'No pull request history yet' : 'Your release inbox is clear'}</h2><p>{githubConnectionPending ? 'Finish connecting the GitHub App to load this repository’s pull requests.' : inboxView === 'history' && dashboard.historyError ? 'Retry loading history to see previous pull requests and their saved results.' : inboxView === 'history' ? 'Previous pull requests and their saved review evidence will appear here.' : 'Review changes here before merging them into the shared theme.'}</p><ExternalLink href={`https://github.com/${dashboard.repository}/pulls`}>Open the repository</ExternalLink></div> : <>
            <div className="detail-heading"><div><div className="pr-context"><ExternalLink href={pull.url}>Pull request #{pull.number}</ExternalLink>{pull.draft && <span className="plain-tag">Draft</span>}</div><h2 ref={detailHeading} tabIndex="-1">{pull.title}</h2><p className="muted">{dashboard.repository} <span aria-hidden="true">·</span> Into <strong>{pull.baseBranch}</strong></p></div><div className="detail-heading-actions">{replay ? <Status value={replayPhase} /> : <><Status value={state} /><button className="button replay-entry" disabled={!mayReplay} title={active || action ? 'Wait for the active release action to finish.' : undefined} onClick={enterReplay}>Test again</button></>}</div></div>
            {replay ? <PresentationReplay key={replay.number} source={replay} onExit={exitReplay} onPhaseChange={setReplayPhase} /> : <>
            <div className="release-toolbar"><div className="commit-strip"><div><span>{closedPull ? 'PR head commit' : 'Current commit'}</span><Commit sha={pull.headSha} label="current commit" /></div><div><span>Reviewed commit</span><Commit sha={run?.headSha} label="reviewed commit" /></div>{closedPull && pull.mergeCommitSha && <div><span>Merge commit</span><Commit sha={pull.mergeCommitSha} label="merge commit" /></div>}</div>{!closedPull && <div className="release-actions"><button className={`button ${!evidenceReady ? 'button--primary' : ''}`} disabled={!mayTest} onClick={testChanges}>{action === 'test' ? 'Starting tests…' : run?.status === 'merge_unknown' ? 'Merge unconfirmed' : run?.status === 'merging' ? 'Merge in progress' : active ? 'Tests in progress' : 'Test changes'}</button><button ref={mergeButton} className={`button ${evidenceReady ? 'button--primary' : ''}`} disabled={!mayMerge} onClick={() => { setActionError(null); setMergeTarget({ number: pull.number, title: pull.title, headSha: pull.headSha, baseBranch: pull.baseBranch, runId: run.id, reviewMode: currentDemo ? 'demo' : 'live' }); }}>{pull.stage === 'live' ? 'Release to live' : `Merge to ${pull.baseBranch}`}</button></div>}</div>
            <StorePreviews key={pull.number} pull={pull} initialPreviews={detail?.pull?.number === pull.number ? detail.previews : undefined} configured={detail?.pull?.number === pull.number ? detail.previewsConfigured : undefined} canGenerate={canMutate && safeCurrentView && !closedPull && !action} canRefresh={!refreshing && !detailLoading && !action && !sessionRefreshNeeded} loading={detailLoading || (!detailMatches && !detailError)} />
            {detailMatches && detail.request && <Notice title={`Requested by ${detail.request.by} via Claude`}><blockquote className="request-quote">{detail.request.text}</blockquote></Notice>}
            {detailError && <Notice title={detailMatches ? 'Could not update pull request details' : 'Could not load pull request details'} tone="warning" action={<button className="text-button" onClick={() => setDetailVersion(value => value + 1)}>Retry</button>}>{detailError.message}{detailMatches && ' Last loaded details are still shown.'}</Notice>}
            {actionError && !mergeTarget && <Notice title="Action could not be completed" tone="warning">{actionError.message}</Notice>}
            {closedPull ? <div className="archive-summary"><strong>{mergedPull ? 'Merged pull request' : 'Closed without merging'}</strong><p>{mergedPull ? 'Merged' : 'Closed'} {date(mergedPull ? pull.mergedAt : pull.closedAt)}{mergedPull && pull.mergedBy ? ` by ${pull.mergedBy}` : ''}. This record is read-only.</p><p className="muted">Saved review and CI results below describe the revisions tested at the time.</p></div> : state === 'merge_unknown' ? <Notice title="Merge outcome needs verification" tone="warning" action={<button className="button" disabled={!canMutate || !safeCurrentView || !!action} onClick={reconcile}>{action === 'reconcile' ? 'Checking…' : 'Check merge outcome'}</button>}>After a two-minute safety hold, check GitHub’s recorded outcome. This only verifies the result; it never retries a merge. If it was not merged, a new test run is required.</Notice> : stale ? <Notice title="This review is out of date" tone="warning">The pull request or its target branch changed after this run. Test the current commit to produce fresh evidence.</Notice> : state === 'running' || state === 'queued' ? <RunProgress run={run} simulated={currentDemo} /> : evidenceReady ? <Notice title="Ready for a manual merge" tone="good">Required checks are complete for this commit. Review the changes below, then confirm the merge.</Notice> : <div className="readiness"><strong>{pull.draft ? 'Draft pull requests cannot be merged' : run ? 'Merge requirements' : 'This commit has not been tested'}</strong>{pull.mergeEligibility?.reasons?.length ? <ul>{pull.mergeEligibility.reasons.map((reason, index) => <li key={index}>{message(reason)}</li>)}</ul> : <p>Start a test run to collect three agent reviews and CI results for this commit.</p>}</div>}
            <div className="evidence-grid"><section className="evidence-section" aria-labelledby="reviews-heading"><div className="section-heading"><h3 id="reviews-heading">Agent reviews</h3><span className="muted">{displayedRun ? `Run ${shortSha(displayedRun.id)}` : closedPull ? 'No saved run' : 'No run yet'}</span></div>{historyRun && historyRun !== run?.id && <p className="historical-note">Historical run · <code>{shortSha(displayedRun?.headSha)}</code>. {closedPull ? 'Saved evidence for this tested revision.' : 'Merge eligibility always uses the latest current-commit evidence.'}</p>}{closedPull && !displayedRun ? <p className="empty-line">No Release Desk reviews were saved for this pull request.</p> : <div className="reviews">{roles.map(([role, title, description]) => <Review key={`${displayedRun?.id}-${role}`} role={role} title={title} description={description} simulated={displayedDemo} review={displayedRun?.reviews?.find(review => review.role === role)} />)}</div>}</section>
              <section className="evidence-section ci-section" aria-labelledby="ci-heading"><div className="section-heading"><h3 id="ci-heading">CI checks</h3><Status value={displayedRun?.ci?.conclusion || displayedRun?.ci?.status || (closedPull ? 'not_recorded' : 'pending')} /></div><p>{displayedRun?.ci?.conclusion === 'success' ? 'The required workflow completed successfully for the tested commit.' : displayedRun?.ci?.conclusion ? `The workflow finished with ${displayedRun.ci.conclusion.replaceAll('_', ' ')}.` : displayedRun?.ci?.status === 'in_progress' ? 'The repository workflow is running.' : closedPull ? 'No saved CI evidence for this pull request.' : 'CI evidence will appear when a test run starts.'}</p>{displayedRun?.ci?.url && <ExternalLink href={displayedRun.ci.url}>View workflow logs</ExternalLink>}{displayedRun?.error && <p className="run-error">{message(displayedRun.error)}</p>}<dl className="run-facts"><div><dt>Started</dt><dd>{date(displayedRun?.createdAt)}</dd></div><div><dt>Updated</dt><dd>{date(displayedRun?.updatedAt)}</dd></div><div><dt>Target commit</dt><dd><code title={displayedRun?.baseSha}>{shortSha(displayedRun?.baseSha)}</code></dd></div></dl></section>
            </div>
            <div className="evidence-grid bottom-grid"><Files key={pull.number} files={detailMatches ? detail.files || [] : []} loading={detailLoading && !detailMatches} error={detailMatches ? null : detailError} unavailableReason={detailMatches ? detail.filesUnavailableReason : null} /><section className="evidence-section history-section" aria-labelledby="history-heading"><div className="section-heading"><h3 id="history-heading">Review history</h3></div>{runs.length ? <ul className="history-list">{runs.slice(0, 5).map(item => <li key={item.id}><button onClick={() => setHistoryRun(item.id === run?.id ? '' : item.id)} aria-pressed={(historyRun || run?.id) === item.id}><span><code>{shortSha(item.headSha)}</code><span className="subline">{date(item.createdAt)}</span></span><Status value={item.status} /></button></li>)}</ul> : <p className="empty-line">No review runs for this pull request.</p>}<p className="deployment-note">{deployment}</p></section></div>
            {detailMatches && detail.commits?.length > 0 && <section className="evidence-section commits-section" aria-labelledby="commits-heading"><div className="section-heading"><h3 id="commits-heading">Who changed what</h3><span className="muted">{detail.commits.length} commit{detail.commits.length === 1 ? '' : 's'}</span></div><ul className="commit-list">{detail.commits.map(item => <li key={item.sha}><span><strong>{item.author}</strong><span className="subline">{date(item.date)} · <code>{shortSha(item.sha)}</code></span></span><span>{item.message}</span></li>)}</ul></section>}
            </>}
          </>}
        </article>
      </div>
      <footer className="app-footer"><span>{replay ? 'Reviewing selected pull request' : 'Updates load when you select Refresh'}</span><span>{fixtureEnabled ? 'Development fixture' : sessionRefreshNeeded ? 'Shopify session refresh needed' : 'Shopify session verified'} · {canMutate ? 'Release reviewer' : 'Read-only access'}</span></footer>
    </main>}
    {!replay && mergeTarget && <MergeDialog target={mergeTarget} currentPull={pull} eligible={mayMerge || action === 'merge'} checking={detailLoading || refreshing} deployment={deployment} busy={action === 'merge'} error={actionError} onClose={() => { setMergeTarget(null); setActionError(null); requestAnimationFrame(() => mergeButton.current?.focus()); }} onMerge={merge} />}
  </div>;
}
