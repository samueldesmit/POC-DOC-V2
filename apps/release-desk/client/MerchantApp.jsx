import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request, externalUrl } from './api.js';
import { formatDate, text as t } from './i18n.js';
import ClaudeConnections from './ClaudeConnections.jsx';

const ACTIVE = new Set(['queued', 'running', 'merging']);
const currentRun = pull => { const run = pull.latestRun; return run && run.headSha === pull.headSha && (!run.baseSha || run.baseSha === pull.baseSha) ? run : null; };

function stateOf(pull) {
  const run = currentRun(pull);
  if (pull.intent?.problem) return { tone: 'bad', label: t.problem, detail: pull.intent.problem };
  if (run && ACTIVE.has(run.status)) return { tone: 'busy', label: t.checking };
  if (run?.status === 'failed') return { tone: 'bad', label: t.problem, detail: t.checkFailed };
  if (pull.intent) return { tone: 'busy', label: pull.intent.kind === 'live' ? t.goingLive : t.queuedStaging };
  if (run?.status === 'passed') return { tone: 'good', label: t.checked };
  return { tone: 'neutral', label: t.notChecked };
}

function Badge({ state }) {
  return <span className={`m-badge m-badge--${state.tone}`}>{state.tone === 'busy' && <span className="m-spinner" aria-hidden="true" />}{state.tone === 'good' && <span aria-hidden="true">✓</span>}{state.label}</span>;
}

function ChangeDetails({ number }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { request(`/api/pulls/${number}`).then(setDetail, setError); }, [number]);
  if (error) return <p className="muted">{error.message}</p>;
  if (!detail) return <p className="muted">{t.loading}</p>;
  return <div className="m-details">
    <p>{t.filesChanged(detail.files.length)}</p>
    <ul>{detail.files.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul>
    {detail.commits?.length > 0 && <ul className="m-steps">{detail.commits.map(commit => <li key={commit.sha}><strong>{commit.author}</strong> · {formatDate(commit.date)}<br />{commit.message}</li>)}</ul>}
  </div>;
}

function ChangeCard({ pull, canAct, busy, onPublish, onWithdraw }) {
  const [open, setOpen] = useState(false);
  const state = stateOf(pull);
  const failed = state.tone === 'bad';
  return <article className="m-change">
    <div className="m-change-head"><h3>{pull.title}</h3><Badge state={state} /></div>
    <p className="muted">{t.askedBy} {pull.requestedBy || pull.author || t.unknown}{pull.requestedBy ? ` ${t.via}` : ''} · {formatDate(pull.createdAt || pull.updatedAt)}</p>
    {pull.request && <blockquote className="m-quote">{pull.request}</blockquote>}
    {state.detail && <p className="m-problem">{state.detail}</p>}
    <div className="m-actions">
      {!pull.intent && <button className="button button--primary" disabled={!canAct || busy || failed} onClick={() => onPublish(pull.number)}>{busy ? <span className="m-spinner" aria-hidden="true" /> : null}{t.toStaging}</button>}
      {pull.intent && !pull.intent.problem && <button className="button" disabled={!canAct || busy} onClick={() => onWithdraw(pull.number)}>{t.cancel}</button>}
      <button className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t.details}</button>
    </div>
    {open && <ChangeDetails number={pull.number} />}
  </article>;
}

export default function MerchantApp({ onTechnical }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showConnect, setShowConnect] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setData(await request('/api/dashboard')); setError(null); }
    catch (failure) { setError(failure); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const pulls = data?.pulls || [];
  const changes = pulls.filter(pull => pull.stage === 'staging');
  const release = pulls.find(pull => pull.stage === 'live') || null;
  const history = (data?.history || []).filter(pull => pull.merged);
  const lastLive = Math.max(0, ...history.filter(pull => pull.stage === 'live').map(pull => Date.parse(pull.mergedAt) || 0));
  const inStaging = history.filter(pull => pull.stage === 'staging' && Date.parse(pull.mergedAt) > lastLive);
  const working = pulls.some(pull => pull.intent || ACTIVE.has(currentRun(pull)?.status));

  // While something is being checked or merged, refresh quietly every 10 seconds.
  useEffect(() => {
    clearTimeout(timer.current);
    if (working) timer.current = setTimeout(() => void load(), 10_000);
    return () => clearTimeout(timer.current);
  }, [working, data, load]);

  const act = async (key, path) => {
    setBusy(key); setActionError(null);
    try { await request(path, { method: 'POST', body: {} }); await load(); }
    catch (failure) { setActionError(failure); await load(); }
    finally { setBusy(null); }
  };
  const canAct = Boolean(data?.actor?.canMutate) && Boolean(data?.setup?.ready);
  const stagingUrl = externalUrl(data?.themes?.stagingPreviewUrl);
  const waiting = data?.release?.aheadBy || 0;

  return <div className="merchant">
    <header className="m-header">
      <div><h1>{t.title}</h1><p className="muted">{data?.shop || ''}</p></div>
      <div className="m-header-actions">
        <button className="button" onClick={() => setShowConnect(value => !value)} aria-expanded={showConnect}>{t.connect}</button>
        <button className="button" onClick={load} disabled={refreshing}>{refreshing ? <><span className="m-spinner" aria-hidden="true" />{t.refreshing}</> : t.refresh}</button>
      </div>
    </header>

    {error && <div className="m-callout m-callout--bad" role="alert"><strong>{t.error}</strong><p>{error.message}</p><button className="button" onClick={load}>{t.tryAgain}</button></div>}
    {actionError && <div className="m-callout m-callout--bad" role="alert"><strong>{t.error}</strong><p>{actionError.message}</p></div>}
    {data && !data.setup?.ready && <div className="m-callout m-callout--warn">{t.setup}</div>}
    {data && !data.actor?.canMutate && <div className="m-callout">{t.readOnly}</div>}
    {showConnect && <ClaudeConnections canCreate={canAct} onClose={() => setShowConnect(false)} />}

    {!data && !error ? <p className="muted m-loading">{t.loading}</p> : data && <>
      <section className="m-card m-how">
        <p className="m-lead">{t.intro}</p>
        <ol className="m-flow">
          <li><strong>1. {t.step1}</strong><span>{t.step1Text}</span></li>
          <li><strong>2. {t.step2}</strong><span>{t.step2Text}</span></li>
          <li><strong>3. {t.step3}</strong><span>{t.step3Text}</span></li>
        </ol>
      </section>

      <section className="m-card">
        <div className="m-card-head"><h2>{t.newChanges}</h2><span className="m-count">{changes.length}</span></div>
        {changes.length ? <div className="m-list">{changes.map(pull => <ChangeCard key={pull.number} pull={pull} canAct={canAct} busy={busy === pull.number} onPublish={number => act(number, `/api/pulls/${number}/publish`)} onWithdraw={number => act(number, `/api/pulls/${number}/withdraw`)} />)}</div> : <p className="muted">{t.noNew}</p>}
      </section>

      <section className="m-card">
        <div className="m-card-head"><h2>{t.staging}</h2>{stagingUrl && <a className="button" href={stagingUrl} target="_blank" rel="noopener noreferrer">{t.viewStaging} ↗</a>}</div>
        {waiting > 0 || release ? <>
          <p>{t.stagingWaiting(Math.max(waiting, inStaging.length))}</p>
          {inStaging.length > 0 && <ul className="m-staged">{inStaging.map(pull => <li key={pull.number}>{pull.title}<span className="muted"> · {pull.requestedBy || pull.author}</span></li>)}</ul>}
          {release && <p><Badge state={stateOf(release)} /></p>}
          {release && stateOf(release).detail && <p className="m-problem">{stateOf(release).detail}</p>}
          {!release?.intent && <div className="m-actions"><button className="button button--primary" disabled={!canAct || busy === 'live'} onClick={() => { if (window.confirm(t.goLiveConfirm)) void act('live', '/api/go-live'); }}>{busy === 'live' ? <span className="m-spinner" aria-hidden="true" /> : null}{t.goLive}</button></div>}
        </> : <p className="muted">{t.stagingSame}</p>}
      </section>

      <section className="m-card">
        <div className="m-card-head"><h2>{t.history}</h2></div>
        {history.length ? <ul className="m-history">{history.slice(0, 15).map(pull => <li key={pull.number}><span><strong>{pull.title}</strong><span className="muted"> · {pull.requestedBy || pull.author}</span></span><span className="muted">{pull.stage === 'live' ? t.wentLive : t.toStagingDone} · {formatDate(pull.mergedAt)}</span></li>)}</ul> : <p className="muted">{t.noHistory}</p>}
      </section>

      <footer className="m-footer"><span className="muted">{t.updated} {formatDate(data.updatedAt)}</span><button className="text-button" onClick={onTechnical}>{t.technical}</button></footer>
    </>}
  </div>;
}
