import React, { useEffect, useId, useRef, useState } from 'react';
import { request } from './api.js';
import { createPreviewRequests, newerPreview, previewView } from './preview-state.js';

const labels = { queued: 'Queued', running: 'Building', ready: 'Ready', partial: 'Partly ready', failed: 'Failed', unavailable: 'Unavailable', stale: 'Out of date' };
const shortSha = value => value?.slice(0, 8) || '—';
const errorText = value => typeof value === 'string' ? value : value?.message || 'Preview generation could not be completed.';
const date = value => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : null;

function PreviewStatus({ status, label }) {
  const tone = status === 'ready' ? 'good' : status === 'failed' ? 'bad' : ['partial', 'stale'].includes(status) ? 'warning' : ['queued', 'running'].includes(status) ? 'active' : 'neutral';
  return <span className={`status status--${tone}`}><span aria-hidden="true" />{label || labels[status] || 'Not generated'}</span>;
}

export default function StorePreviews({ pull, initialPreviews, configured: initialConfigured, canGenerate, canRefresh, loading }) {
  const [snapshot, setSnapshot] = useState(initialPreviews || null);
  const [configured, setConfigured] = useState(initialConfigured);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const requests = useRef(null);
  const headingId = useId();

  useEffect(() => {
    setSnapshot(current => newerPreview(current, initialPreviews));
    if (typeof initialConfigured === 'boolean') setConfigured(initialConfigured);
  }, [initialPreviews, initialConfigured]);

  useEffect(() => {
    setPending(null); setError(null);
    const controller = createPreviewRequests({
      request,
      onStart: operation => { setPending(operation); setError(null); },
      onResult: result => { setSnapshot(result.previews); setConfigured(result.configured); },
      onError: setError,
      onFinish: () => setPending(null),
    });
    requests.current = controller;
    return () => { controller.dispose(); if (requests.current === controller) requests.current = null; };
  }, [pull.number, pull.headSha, pull.baseSha]);

  const view = previewView(snapshot, pull);
  const generateAllowed = configured === true && canGenerate && !loading && !pending && !view.busy;
  const refreshAllowed = canRefresh && !loading && !pending;
  const generate = () => { if (generateAllowed) requests.current?.load({ number: pull.number, headSha: pull.headSha, generate: true }); };
  const refresh = () => { if (refreshAllowed) requests.current?.load({ number: pull.number, headSha: pull.headSha }); };
  const updatedAt = date(snapshot?.updatedAt || snapshot?.createdAt);

  return <section className="evidence-section preview-panel" aria-labelledby={headingId} aria-busy={!!pending}>
    <div className="preview-heading"><div><h3 id={headingId}>Store preview</h3><p>Open this change on an unpublished copy of the live store.</p></div><div className="preview-actions"><button className="button" disabled={!generateAllowed} onClick={generate}>{pending === 'generate' ? 'Generating…' : 'Generate preview'}</button><button className="button" disabled={!refreshAllowed} onClick={refresh}>{pending === 'refresh' ? 'Refreshing…' : 'Refresh status'}</button></div></div>
    {loading && !snapshot ? <p className="preview-message" role="status">Loading preview details…</p> : configured === false ? <p className="preview-message">Store previews are not configured yet. Ask the app administrator to add a Theme Access password.</p> : configured === undefined ? <p className="preview-message">Use Refresh status to check preview availability.</p> : !snapshot ? <p className="preview-message">No previews have been generated for this pull request.{pull.state === 'closed' ? '' : ' Generate previews to inspect its storefront changes.'}</p> : null}
    {view.stale && <p className="preview-message preview-message--stale" role="status">These previews are out of date. They were generated for <code>{shortSha(snapshot.headSha)}</code>; the current revision is <code>{shortSha(pull.headSha)}</code>{snapshot.headSha === pull.headSha ? ' and its target branch has changed' : ''}.{pull.state === 'closed' ? ' Saved preview links no longer match this revision.' : ' Generate previews again to view the current changes.'}</p>}
    {error && <p className="preview-message preview-message--error" role="alert">{errorText(error)}{snapshot ? ' The last loaded preview status is still shown.' : ''}</p>}
    {snapshot && <>
      <div className="preview-meta"><span>Preview commit <code title={snapshot.headSha}>{shortSha(snapshot.headSha)}</code>{updatedAt ? ` · Updated ${updatedAt}` : ''}</span><PreviewStatus status={view.stale ? 'stale' : snapshot.status} /></div>
      <div className="preview-stores">{view.markets.map(store => <article className="preview-store" key={store.market}><div className="section-heading"><h4>{store.name}</h4><PreviewStatus status={store.status} /></div>{store.links.length > 0 ? <ul className="preview-links">{store.links.map((link, index) => <li key={`${link.url}-${index}`}><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<span className="external-mark" aria-hidden="true">↗</span><span className="sr-only"> — {store.name}, opens in a new tab</span></a></li>)}</ul> : <p className="preview-store-note">{store.status === 'stale' ? 'No current preview links are available.' : ['running', 'queued'].includes(store.status) ? 'Use Refresh status to check when the preview is ready.' : store.error ? errorText(store.error) : 'No preview links were returned for this store.'}</p>}</article>)}</div>
      {snapshot.error && <p className="preview-message preview-message--error">{errorText(snapshot.error)}</p>}
      {Array.isArray(snapshot.notes) && snapshot.notes.length > 0 && <ul className="preview-notes">{snapshot.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    </>}
    <p className="preview-footnote">{snapshot && view.busy ? 'Generation continues in the background. ' : ''}Status updates only when you select Refresh status. Previews never publish the store.</p>
  </section>;
}
