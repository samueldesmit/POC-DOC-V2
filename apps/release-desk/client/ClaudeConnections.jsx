import React, { useEffect, useId, useState } from 'react';
import { request } from './api.js';

const date = value => value ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'never';

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

  return <section className="sheet connections" aria-labelledby={headingId}>
    <div className="section-heading"><h2 id={headingId}>Connect Claude</h2><button className="text-button" onClick={onClose}>Close</button></div>
    <p>Ask Claude to change the theme in your own words. Claude can only read the theme and propose changes: every change becomes a pull request into staging under your name, and appears here to test, preview and release. Claude can never merge or put anything live.</p>
    {created ? <div className="notice notice--good connection-created"><div>
      <strong>Your connection link</strong>
      <p>Copy it now. It is shown only once and works like a password: anyone with this link can propose changes under your name.</p>
      <div className="connection-url"><code>{created.url}</code><button className="button" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button></div>
      <ol>
        <li>Claude Desktop or claude.ai: Settings, Connectors, Add custom connector.</li>
        <li>Name it “{created.connection?.name ? `Theme (${created.connection.name})` : 'Theme'}” and paste the link as the URL.</li>
        <li>Start a chat and ask, for example: “Make the buttons on the product page green.”</li>
      </ol>
      <p className="muted">Claude Code: <code>claude mcp add --transport http theme {'<link>'}</code></p>
    </div></div> : canCreate ? <form className="connection-form" onSubmit={create}>
      <label>Your name<input value={name} onChange={event => setName(event.target.value)} required minLength={2} maxLength={80} autoComplete="name" /></label>
      <label>Your email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required maxLength={120} autoComplete="email" /></label>
      <button className="button button--primary" disabled={busy}>{busy ? 'Creating…' : 'Create connection link'}</button>
      <p className="muted">Your name and email are recorded on every change Claude makes for you.</p>
    </form> : <p className="muted">Only release reviewers can connect Claude to this theme.</p>}
    {error && <div className="notice notice--warning" role="alert"><div><strong>Could not complete that</strong><div>{error.message}</div></div></div>}
    <h3>Your active connections</h3>
    {!connections ? <p className="muted">Loading…</p> : connections.length ? <ul className="connection-list">{connections.map(item => <li key={item.id}><span><strong>{item.name}</strong><span className="subline">{item.email} · created {date(item.createdAt)} · last used {date(item.lastUsedAt)}</span></span><button className="button" disabled={busy} onClick={() => revoke(item.id)}>Revoke</button></li>)}</ul> : <p className="muted">No active connections.</p>}
  </section>;
}
