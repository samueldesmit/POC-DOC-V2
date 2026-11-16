import React, { useEffect, useId, useState } from 'react';
import { request } from './api.js';
import { formatDate, text as t } from './i18n.js';

// Personal Claude connections. A link is shown exactly once; afterwards only
// its name and last use are visible, and it can be revoked at any time.
export default function ClaudeConnections({ canCreate, onClose }) {
  const [connections, setConnections] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const headingId = useId();

  const load = async () => {
    try { setConnections((await request('/api/connections')).connections); setError(null); }
    catch (failure) { setError(failure); }
  };
  useEffect(() => { void load(); }, []);

  const create = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setCopied(false);
    try { setCreated(await request('/api/connections', { method: 'POST', body: { name, email } })); await load(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const revoke = async id => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await request(`/api/connections/${id}`, { method: 'DELETE' }); if (created?.connection?.id === id) setCreated(null); await load(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(created.url); setCopied(true); } catch { setCopied(false); } };

  return <section className="m-card connections" aria-labelledby={headingId}>
    <div className="m-card-head"><h2 id={headingId}>{t.cTitle}</h2><button className="text-button" onClick={onClose}>{t.cClose}</button></div>
    <p className="m-lead">{t.cIntro}</p>
    {created ? <div className="m-callout m-callout--good" style={{ boxShadow: "none", background: "#f7f7f7" }}>
      <strong>{t.cLink}</strong>
      <p>{t.cLinkNote}</p>
      <div className="connection-url"><code>{created.url}</code><button className="button button--primary" onClick={copy}>{copied ? t.cCopied : t.cCopy}</button></div>
      <ol>
        <li>{t.cStep1}</li>
        <li>{t.cStep2(created.connection?.name ? `Webshop (${created.connection.name})` : 'Webshop')}</li>
        <li>{t.cStep3}</li>
      </ol>
    </div> : canCreate ? <form className="connection-form" onSubmit={create}>
      <label>{t.cName}<input value={name} onChange={event => setName(event.target.value)} required minLength={2} maxLength={80} autoComplete="name" /></label>
      <label>{t.cEmail}<input type="email" value={email} onChange={event => setEmail(event.target.value)} required maxLength={120} autoComplete="email" /></label>
      <button className="button button--primary" disabled={busy}>{busy ? <><span className="m-spinner" aria-hidden="true" />{t.cCreating}</> : t.cCreate}</button>
      <p className="muted">{t.cNote}</p>
    </form> : <p className="muted">{t.cOnlyReviewers}</p>}
    {error && <div className="m-callout m-callout--bad" role="alert"><strong>{t.cFailed}</strong><p>{error.message}</p></div>}
    <h3>{t.cActive}</h3>
    {!connections ? <p className="muted">{t.loading}</p> : connections.length ? <ul className="connection-list">{connections.map(item => <li key={item.id}><span><strong>{item.name}</strong><span className="subline">{item.email} · {t.cCreated} {formatDate(item.createdAt)} · {t.cUsed} {item.lastUsedAt ? formatDate(item.lastUsedAt) : t.cNever}</span></span><button className="button" disabled={busy} onClick={() => revoke(item.id)}>{t.cRevoke}</button></li>)}</ul> : <p className="muted">{t.cNone}</p>}
  </section>;
}
