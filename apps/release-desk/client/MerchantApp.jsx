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
  eye: <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="m-icon"><path fillRule="evenodd" d="M10 4C5.5 4 2.3 7.3 1.2 9.6a1 1 0 000 .8C2.3 12.7 5.5 16 10 16s7.7-3.3 8.8-5.6a1 1 0 000-.8C17.7 7.3 14.5 4 10 4zm0 9.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7zm0-2a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" clipRule="evenodd" /></svg>,
};
const PALETTE = ['#5c2fc2', '#0b7a75', '#b54708', '#005bd3', '#a3195b', '#2d6a1f'];
const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || '?';
const colour = name => PALETTE[[...String(name || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0) % PALETTE.length];
const isRemoval = pull => /^Remove: /.test(pull.title || '');
const plainTitle = pull => isRemoval(pull) ? pull.title.replace(/^Remove: /, '') : pull.title;

function stateOf(pull) {
  const run = currentRun(pull);
  if (pull.intent?.problem) return { tone: 'bad', label: t.problem, detail: pull.intent.problem };
  if (run?.status === 'failed') return { tone: 'bad', label: t.problem, detail: t.checkFailed };
  if (run && ACTIVE.has(run.status)) return { tone: 'busy', label: t.checking };
  if (run?.status === 'passed' && pull.stage === 'live') return { tone: 'busy', label: t.goingLive };
  return { tone: 'busy', label: t.notChecked };
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

// One change: who asked, what they asked, and (optionally) its status and one action.
function Change({ pull, badge, hint, action }) {
  const [open, setOpen] = useState(false);
  const who = pull.requestedBy || pull.author || t.unknown;
  return <article className="m-change">
    <span className="m-avatar" style={{ background: colour(who) }} aria-hidden="true">{initials(who)}</span>
    <div className="m-change-head"><h3>{isRemoval(pull) ? `${t.removing}: ${plainTitle(pull)}` : pull.title}</h3>{badge}</div>
    <p className="muted">{t.askedBy} {who}{pull.requestedBy ? ` ${t.via}` : ''} · {formatDate(pull.mergedAt || pull.createdAt || pull.updatedAt)}</p>
    {pull.request && <blockquote className="m-quote">{pull.request}</blockquote>}
    {hint}
    <div className="m-actions" style={{ gridColumn: 2, marginTop: 6 }}>
      {action}
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
  const version = useRef(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setData(await request('/api/dashboard')); setError(null); }
    catch (failure) { setError(failure); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Live updates: ask the server every few seconds whether anything changed (a tiny
  // local check), and reload the overview only when it did. Paused while the tab is hidden.
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

  const act = async (key, path, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key); setActionError(null);
    try { await request(path, { method: 'POST', body: {} }); await load(); }
    catch (failure) { setActionError(failure); await load(); }
    finally { setBusy(null); }
  };

  const pulls = data?.pulls || [];
  const preparing = pulls.filter(pull => pull.stage === 'staging');
  const release = pulls.find(pull => pull.stage === 'live') || null;
  const merged = (data?.history || []).filter(pull => pull.merged);
  const stagedNumbers = new Set(data?.release?.pulls || []);
  const inTest = (data?.release?.aheadBy || 0) > 0 ? merged.filter(pull => pull.stage === 'staging' && stagedNumbers.has(pull.number) && !isRemoval(pull)) : [];
  const ahead = inTest.length > 0 || (data?.release?.aheadBy || 0) > 0;
  // History: the changes each release took live, each shown once, when it first went live.
  const liveEntries = merged.filter(pull => pull.stage === 'live').flatMap(pull => pull.release ? (pull.includes || []).map(item => ({ ...item, key: `c${item.number}`, mergedAt: pull.mergedAt })) : [{ ...pull, key: `p${pull.number}` }]);
  const firstLive = new Map();
  for (const entry of liveEntries) { const known = firstLive.get(entry.key); if (!known || Date.parse(entry.mergedAt) < Date.parse(known.mergedAt)) firstLive.set(entry.key, entry); }
  const history = [...firstLive.values()].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  const canAct = Boolean(data?.actor?.canMutate) && Boolean(data?.setup?.ready);
  const stagingUrl = externalUrl(data?.themes?.stagingPreviewUrl);
  const spinner = key => busy === key ? <span className="m-spinner" aria-hidden="true" /> : null;

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
        <div className="m-hero-top"><span className="m-hero-icon">{Icon.sparkle}</span><p className="m-lead">{t.intro2}</p></div>
        <ol className="m-flow">
          <li><span className="m-num">1</span><strong>{t.s1}</strong><span>{t.s1t}</span></li>
          <li><span className="m-num">2</span><strong>{t.s2}</strong><span>{t.s2t}</span></li>
          <li><span className="m-num">3</span><strong>{t.s3}</strong><span>{t.s3t}</span></li>
        </ol>
      </section>

      {preparing.length > 0 && <section className="m-card">
        <div className="m-card-head"><div className="m-card-title"><h2>{t.preparing}</h2><span className="m-count">{preparing.length}</span></div></div>
        <div className="m-list">{preparing.map(pull => {
          const state = stateOf(pull);
          return <Change key={pull.number} pull={pull} badge={<Badge state={state} />}
            hint={state.detail ? <p className="m-problem" style={{ gridColumn: 2 }}>{Icon.alert}<span>{state.detail}</span></p> : <p className="muted" style={{ gridColumn: 2, fontSize: 12 }}>{t.preparingHint}</p>}
            action={!isRemoval(pull) && <button className="button" disabled={!canAct || busy !== null} onClick={() => act(`d${pull.number}`, `/api/pulls/${pull.number}/discard`, t.discardConfirm)}>{spinner(`d${pull.number}`)}{t.discard}</button>} />;
        })}</div>
      </section>}

      <section className="m-card">
        <div className="m-card-head"><h2>{t.staging}</h2>{stagingUrl && <a className="button" href={stagingUrl} target="_blank" rel="noopener noreferrer"><span className="m-icon">{Icon.eye}</span>{t.viewStaging}</a>}</div>
        {ahead ? <>
          <div className="m-stage"><span className="m-stage-icon m-stage-icon--waiting">{Icon.clock}</span><div style={{ display: 'grid', gap: 2 }}><strong>{t.inTest(inTest.length || 1)}</strong><span className="muted">{t.testIntro}</span></div></div>
          {inTest.length > 0 && <div className="m-list">{inTest.map(pull => <Change key={pull.number} pull={pull}
            action={<button className="button" disabled={!canAct || busy !== null || Boolean(release?.intent)} onClick={() => act(`r${pull.number}`, `/api/pulls/${pull.number}/remove`, t.removeConfirm)}>{spinner(`r${pull.number}`)}{t.remove}</button>} />)}</div>}
          {release?.intent || (release && ACTIVE.has(currentRun(release)?.status)) ? <div><Badge state={stateOf(release)} /></div> : null}
          {release && stateOf(release).detail && <p className="m-problem">{Icon.alert}<span>{stateOf(release).detail}</span></p>}
          {!release?.intent && <div className="m-actions"><button className="button button--primary" disabled={!canAct || busy !== null || preparing.some(isRemoval)} onClick={() => act('live', '/api/go-live', t.goLiveConfirm)}>{spinner('live')}{t.goLive}</button></div>}
        </> : <div className="m-stage"><span className="m-stage-icon m-stage-icon--done">{Icon.check}</span><span className="muted" style={{ paddingTop: 6 }}>{t.stagingSame}</span></div>}
      </section>

      <section className="m-card">
        <h2>{t.history}</h2>
        {history.length ? <ul className="m-history">{history.slice(0, 15).map(pull => <li key={pull.key}><span className="m-dot" aria-hidden="true" /><span><strong>{pull.title}</strong>{(pull.requestedBy || pull.author) && <span className="muted"> · {pull.requestedBy || pull.author}</span>}</span><span className="muted">{t.wentLive} · {formatDate(pull.mergedAt)}</span></li>)}</ul> : <div className="m-empty"><span>{t.noHistory}</span></div>}
      </section>

      <footer className="m-footer"><span className="muted">{t.updated} {formatDate(data.updatedAt)}</span><button className="text-button" onClick={onTechnical}>{t.technical}</button></footer>
    </>}
  </div></div>;
}
