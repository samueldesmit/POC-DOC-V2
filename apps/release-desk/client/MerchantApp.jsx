import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request, externalUrl } from './api.js';
import { formatDate, text as t } from './i18n.js';
import ClaudeConnections from './ClaudeConnections.jsx';

const ACTIVE = new Set(['queued', 'running', 'merging']);
const currentRun = pull => { const run = pull.latestRun; return run && run.headSha === pull.headSha && (!run.baseSha || run.baseSha === pull.baseSha) ? run : null; };

const Icon = {
  sparkle: <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 1.5l1.6 4.4a2 2 0 001.2 1.2L17.2 8.7l-4.4 1.6a2 2 0 00-1.2 1.2L10 15.9l-1.6-4.4a2 2 0 00-1.2-1.2L2.8 8.7l4.4-1.6a2 2 0 001.2-1.2L10 1.5zm6 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" /></svg>,
  check: <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" /></svg>,
  clock: <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M10 2a8 8 0 100 16 8 8 0 000-16zm.8 4a.8.8 0 00-1.6 0v4.3c0 .3.1.5.3.6l2.8 2a.8.8 0 00.9-1.3l-2.4-1.7V6z" clipRule="evenodd" /></svg>,
  alert: <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="m-icon"><path fillRule="evenodd" d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a.8.8 0 01.8.8v3.6a.8.8 0 01-1.6 0V6.8A.8.8 0 0110 6zm0 8.2a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>,
  inbox: <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M4.6 3h10.8a1.6 1.6 0 011.5 1.1l1.9 6V15a2 2 0 01-2 2H3.2a2 2 0 01-2-2v-4.9l1.9-6A1.6 1.6 0 014.6 3zm-.1 1.6L2.9 9.8h4l.6 1.4c.2.4.6.7 1.1.7h2.8c.5 0 .9-.3 1.1-.7l.6-1.4h4l-1.6-5.2H4.5z" clipRule="evenodd" /></svg>,
  external: <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="m-icon"><path d="M11 3a1 1 0 100 2h2.6l-6.3 6.3a1 1 0 001.4 1.4L15 6.4V9a1 1 0 102 0V4a1 1 0 00-1-1h-5zM5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" /></svg>,
};
const PALETTE = ['#5c2fc2', '#0b7a75', '#b54708', '#005bd3', '#a3195b', '#2d6a1f'];
const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || '?';
const colour = name => PALETTE[[...String(name || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0) % PALETTE.length];

function stateOf(pull) {
  const run = currentRun(pull);
  if (pull.intent?.problem) return { tone: 'bad', label: t.problem, detail: pull.intent.problem };
  if (run && ACTIVE.has(run.status)) return { tone: 'busy', label: t.checking, hint: true };
  if (run?.status === 'failed') return { tone: 'bad', label: t.problem, detail: t.checkFailed };
  if (pull.intent) return { tone: 'busy', label: pull.intent.kind === 'live' ? t.goingLive : t.queuedStaging };
  if (run?.status === 'passed') return { tone: 'good', label: t.checked };
  return { tone: 'busy', label: t.notChecked, hint: true };
}

function Badge({ state }) {
  return <span className={`m-badge m-badge--${state.tone}`}>{state.tone === 'busy' && <span className="m-spinner" aria-hidden="true" />}{state.tone === 'good' && <span className="m-icon" style={{ width: 12, height: 12 }}>{Icon.check}</span>}{state.label}</span>;
}

function ChangeDetails({ number }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { request(`/api/pulls/${number}`).then(setDetail, setError); }, [number]);
  if (error) return <div className="m-details">{error.message}</div>;
  if (!detail) return <div className="m-details">{t.loading}</div>;
  return <div className="m-details">
    <strong>{t.filesChanged(detail.files.length)}</strong>
    <ul>{detail.files.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul>
    {detail.commits?.length > 0 && <ul>{detail.commits.map(commit => <li key={commit.sha}>{commit.message} <span className="muted">· {commit.author}, {formatDate(commit.date)}</span></li>)}</ul>}
  </div>;
}

function ChangeCard({ pull, canAct, busy, onPublish, onWithdraw }) {
  const [open, setOpen] = useState(false);
  const state = stateOf(pull);
  const who = pull.requestedBy || pull.author || t.unknown;
  return <article className="m-change">
    <span className="m-avatar" style={{ background: colour(who) }} aria-hidden="true">{initials(who)}</span>
    <div className="m-change-head"><h3>{pull.title}</h3><Badge state={state} /></div>
    <p className="muted">{t.askedBy} {who}{pull.requestedBy ? ` ${t.via}` : ''} · {formatDate(pull.createdAt || pull.updatedAt)}</p>
    {pull.request && <blockquote className="m-quote">{pull.request}</blockquote>}
    {state.detail && <p className="m-problem">{Icon.alert}<span>{state.detail}</span></p>}
    {state.hint && !pull.intent && <p className="muted" style={{ fontSize: 12 }}>{t.busyHint}</p>}
    <div className="m-actions" style={{ gridColumn: 2, marginTop: 6 }}>
      {!pull.intent && <button className="button button--primary" disabled={!canAct || busy || state.tone === 'bad'} onClick={() => onPublish(pull.number)}>{busy && <span className="m-spinner" aria-hidden="true" />}{t.toStaging}</button>}
      {pull.intent && !pull.intent.problem && <button className="button" disabled={!canAct || busy} onClick={() => onWithdraw(pull.number)}>{t.cancel}</button>}
      <button className="text-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t.details}</button>
    </div>
    {open && <div style={{ gridColumn: 2 }}><ChangeDetails number={pull.number} /></div>}
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
  const merged = (data?.history || []).filter(pull => pull.merged);
  // History is what went live. What is only in the test version shows in its own section,
  // and only while the test version is actually ahead of live.
  // A release lists the changes it took live; an empty release (nothing new) is left out.
  const liveEntries = merged.filter(pull => pull.stage === 'live').flatMap(pull => pull.release ? (pull.includes || []).map(item => ({ ...item, key: `${pull.number}-${item.number}`, mergedAt: pull.mergedAt })) : [{ ...pull, key: String(pull.number) }]);
  // A change can be named by more than one release; show it once, when it first went live.
  const firstLive = new Map();
  for (const entry of liveEntries) { const id = entry.release === undefined && entry.number ? `c${entry.number}` : entry.key; const known = firstLive.get(id); if (!known || Date.parse(entry.mergedAt) < Date.parse(known.mergedAt)) firstLive.set(id, entry); }
  const history = [...firstLive.values()].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  const waiting = data?.release?.aheadBy || 0;
  // Exactly the changes that are on the test version and not live (from the server's comparison).
  const stagedNumbers = new Set(data?.release?.pulls || []);
  const inStaging = waiting > 0 ? merged.filter(pull => pull.stage === 'staging' && stagedNumbers.has(pull.number)) : [];
  // Live updates: ask the server every few seconds whether anything changed (a tiny
  // local check), and reload the overview only when it did. Paused while the tab is hidden.
  const version = useRef(null);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try {
          const { version: next } = await request('/api/version');
          if (version.current !== null && next !== version.current) await load();
          version.current = next;
        } catch { /* keep the last overview; the next tick tries again */ }
      }
      if (!stopped) timer.current = setTimeout(tick, 3_000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer.current); };
  }, [load]);

  const act = async (key, path) => {
    setBusy(key); setActionError(null);
    try { await request(path, { method: 'POST', body: {} }); await load(); }
    catch (failure) { setActionError(failure); await load(); }
    finally { setBusy(null); }
  };
  const canAct = Boolean(data?.actor?.canMutate) && Boolean(data?.setup?.ready);
  const stagingUrl = externalUrl(data?.themes?.stagingPreviewUrl);
  const ahead = waiting > 0 || Boolean(release);

  return <div className="merchant"><div className="merchant-inner">
    <header className="m-header">
      <div><h1>{t.title}</h1><p className="muted">{data?.shop || ''}</p></div>
      <div className="m-header-actions">
        <button className="button" onClick={load} disabled={refreshing}>{refreshing && <span className="m-spinner" aria-hidden="true" />}{t.refresh}</button>
        <button className="button button--primary" onClick={() => setShowConnect(value => !value)} aria-expanded={showConnect}><span className="m-icon">{Icon.sparkle}</span>{t.connect}</button>
      </div>
    </header>

    {error && <div className="m-callout m-callout--bad" role="alert"><strong>{t.error}</strong><span>{error.message}</span><div><button className="button" onClick={load}>{t.tryAgain}</button></div></div>}
    {actionError && <div className="m-callout m-callout--bad" role="alert"><strong>{t.error}</strong><span>{actionError.message}</span></div>}
    {data && !data.setup?.ready && <div className="m-callout m-callout--warn">{t.setup}</div>}
    {data && !data.actor?.canMutate && <div className="m-callout">{t.readOnly}</div>}
    {showConnect && <ClaudeConnections canCreate={canAct} onClose={() => setShowConnect(false)} />}

    {!data && !error ? <p className="muted m-loading">{t.loading}</p> : data && <>
      <section className="m-card m-hero">
        <div className="m-hero-top"><span className="m-hero-icon">{Icon.sparkle}</span><p className="m-lead">{t.intro}</p></div>
        <ol className="m-flow">
          <li><span className="m-num">1</span><strong>{t.step1}</strong><span>{t.step1Text}</span></li>
          <li><span className="m-num">2</span><strong>{t.step2}</strong><span>{t.step2Text}</span></li>
          <li><span className="m-num">3</span><strong>{t.step3}</strong><span>{t.step3Text}</span></li>
        </ol>
      </section>

      <section className="m-card">
        <div className="m-card-head"><div className="m-card-title"><h2>{t.newChanges}</h2>{changes.length > 0 && <span className="m-count">{changes.length}</span>}</div></div>
        {changes.length ? <div className="m-list">{changes.map(pull => <ChangeCard key={pull.number} pull={pull} canAct={canAct} busy={busy === pull.number} onPublish={number => act(number, `/api/pulls/${number}/publish`)} onWithdraw={number => act(number, `/api/pulls/${number}/withdraw`)} />)}</div>
          : <div className="m-empty">{Icon.inbox}<span>{t.noNew}</span></div>}
      </section>

      <section className="m-card">
        <div className="m-card-head"><h2>{t.staging}</h2>{stagingUrl && <a className="button" href={stagingUrl} target="_blank" rel="noopener noreferrer">{t.viewStaging}<span className="m-icon">{Icon.external}</span></a>}</div>
        <div className="m-stage">
          <span className={`m-stage-icon m-stage-icon--${ahead ? 'waiting' : 'done'}`}>{ahead ? Icon.clock : Icon.check}</span>
          <div style={{ display: 'grid', gap: 8, flex: 1 }}>
            {ahead ? <>
              <strong>{t.stagingWaiting(inStaging.length || Math.max(waiting, 1))}</strong>
              {inStaging.length > 0 && <ul className="m-staged">{inStaging.map(pull => <li key={pull.number}>{pull.title} <span className="muted">· {pull.requestedBy || pull.author}</span></li>)}</ul>}
              {release && <div><Badge state={stateOf(release)} /></div>}
              {release && stateOf(release).detail && <p className="m-problem">{Icon.alert}<span>{stateOf(release).detail}</span></p>}
              {!release?.intent && <div className="m-actions"><button className="button button--primary" disabled={!canAct || busy === 'live'} onClick={() => { if (window.confirm(t.goLiveConfirm)) void act('live', '/api/go-live'); }}>{busy === 'live' && <span className="m-spinner" aria-hidden="true" />}{t.goLive}</button></div>}
            </> : <span className="muted" style={{ paddingTop: 6 }}>{t.stagingSame}</span>}
          </div>
        </div>
      </section>

      <section className="m-card">
        <h2>{t.history}</h2>
        {history.length ? <ul className="m-history">{history.slice(0, 15).map(pull => <li key={pull.key}><span className="m-dot" aria-hidden="true" /><span><strong>{pull.title}</strong>{(pull.requestedBy || pull.author) && <span className="muted"> · {pull.requestedBy || pull.author}</span>}</span><span className="muted">{t.wentLive} · {formatDate(pull.mergedAt)}</span></li>)}</ul> : <div className="m-empty"><span>{t.noHistory}</span></div>}
      </section>

      <footer className="m-footer"><span className="muted">{t.updated} {formatDate(data.updatedAt)}</span><button className="text-button" onClick={onTechnical}>{t.technical}</button></footer>
    </>}
  </div></div>;
}
