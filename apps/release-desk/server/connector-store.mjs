import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DeskError, nowIso } from './errors.mjs';

const hash = token => createHash('sha256').update(token).digest();
export const CONNECTOR_TOKEN = /^rdc_[A-Za-z0-9_-]{43}$/;

// Personal Claude connections and the changes made through them. A token is
// shown once; only its SHA-256 is stored. Every change belongs to one person.
export class ConnectorStore {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, token_hash BLOB NOT NULL UNIQUE, user_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, created INTEGER NOT NULL, revoked INTEGER, last_used INTEGER);
      CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL UNIQUE, title TEXT NOT NULL, request TEXT NOT NULL, pr INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_calls(connection_id TEXT NOT NULL, created INTEGER NOT NULL, write INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS connector_calls_recent ON connector_calls(connection_id, created);
    `);
  }
  create(actor, { name, email }) {
    const active = this.db.prepare('SELECT COUNT(*) n FROM connections WHERE user_id=? AND revoked IS NULL').get(actor.id).n;
    if (active >= 5) throw new DeskError('CONNECTION_LIMIT', 'You already have five active Claude connections. Revoke one first.', 429);
    const token = `rdc_${randomBytes(32).toString('base64url')}`;
    const connection = { id: randomUUID(), userId: actor.id, name, email, createdAt: nowIso() };
    this.db.prepare('INSERT INTO connections(id,token_hash,user_id,name,email,created) VALUES(?,?,?,?,?,?)').run(connection.id, hash(token), actor.id, name, email, Date.now());
    this.store.audit(actor.id, 'connection.created', { connectionId: connection.id });
    return { connection, token };
  }
  list(userId) {
    return this.db.prepare('SELECT id,name,email,created,last_used FROM connections WHERE user_id=? AND revoked IS NULL ORDER BY created DESC').all(userId)
      .map(row => ({ id: row.id, name: row.name, email: row.email, createdAt: new Date(row.created).toISOString(), lastUsedAt: row.last_used ? new Date(row.last_used).toISOString() : null }));
  }
  revoke(actor, id) {
    const result = this.db.prepare('UPDATE connections SET revoked=? WHERE id=? AND user_id=? AND revoked IS NULL').run(Date.now(), id, actor.id);
    if (!result.changes) throw new DeskError('CONNECTION_NOT_FOUND', 'Connection not found.', 404);
    this.store.audit(actor.id, 'connection.revoked', { connectionId: id });
  }
  // Constant-time comparison on the stored hash; revoked tokens never match.
  verify(token) {
    if (typeof token !== 'string' || !CONNECTOR_TOKEN.test(token)) return null;
    const digest = hash(token);
    const row = this.db.prepare('SELECT id,token_hash,user_id,name,email FROM connections WHERE token_hash=? AND revoked IS NULL').get(digest);
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash), digest)) return null;
    this.db.prepare('UPDATE connections SET last_used=? WHERE id=?').run(Date.now(), row.id);
    return { connectionId: row.id, userId: row.user_id, name: row.name, email: row.email };
  }
  // Sliding one-hour budget per connection: reads and writes counted separately.
  allow(connectionId, write, { reads = 600, writes = 60 } = {}) {
    const since = Date.now() - 3_600_000;
    this.db.prepare('DELETE FROM connector_calls WHERE created<?').run(since);
    const used = this.db.prepare('SELECT COUNT(*) n FROM connector_calls WHERE connection_id=? AND write=? AND created>=?').get(connectionId, write ? 1 : 0, since).n;
    if (used >= (write ? writes : reads)) return false;
    this.db.prepare('INSERT INTO connector_calls(connection_id,created,write) VALUES(?,?,?)').run(connectionId, Date.now(), write ? 1 : 0);
    return true;
  }
  addChange(identity, { branch, title, request }) {
    const change = { id: branch.slice('claude/'.length), branch, title, request };
    this.db.prepare('INSERT INTO changes(id,connection_id,user_id,name,branch,title,request,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').run(change.id, identity.connectionId, identity.userId, identity.name, branch, title, request, Date.now(), Date.now());
    this.store.audit(identity.userId, 'change.started', { changeId: change.id, branch });
    return this.change(change.id);
  }
  change(id) {
    const row = this.db.prepare('SELECT * FROM changes WHERE id=?').get(id);
    return row ? { id: row.id, userId: row.user_id, name: row.name, branch: row.branch, title: row.title, request: row.request, prNumber: row.pr, createdAt: new Date(row.created).toISOString(), updatedAt: new Date(row.updated).toISOString() } : null;
  }
  changesFor(userId, limit = 20) { return this.db.prepare('SELECT id FROM changes WHERE user_id=? ORDER BY created DESC LIMIT ?').all(userId, limit).map(row => this.change(row.id)); }
  changeForPull(number) { const row = this.db.prepare('SELECT id FROM changes WHERE pr=?').get(number); return row ? this.change(row.id) : null; }
  setPull(id, number) { this.db.prepare('UPDATE changes SET pr=?,updated=? WHERE id=?').run(number, Date.now(), id); }
  touch(id) { this.db.prepare('UPDATE changes SET updated=? WHERE id=?').run(Date.now(), id); }
}
