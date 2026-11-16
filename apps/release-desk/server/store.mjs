import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeskError, nowIso } from './errors.mjs';

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, pr INTEGER NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_pr ON runs(pr) WHERE status IN ('queued','running','merging');
      CREATE TABLE IF NOT EXISTS locks(pr INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, received INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, created INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  audit(actor, action, detail = {}) {
    // Callers supply structured identifiers/outcomes only, never request headers or credentials.
    this.db.prepare('INSERT INTO audit(created,actor,action,body) VALUES(?,?,?,?)').run(Date.now(), actor || 'system', action, JSON.stringify(detail));
  }
  getRun(id) { const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; }
  listRuns(pr = null, limit = 100) {
    const rows = pr === null ? this.db.prepare('SELECT body FROM runs ORDER BY created DESC LIMIT ?').all(limit) : this.db.prepare('SELECT body FROM runs WHERE pr=? ORDER BY created DESC LIMIT ?').all(pr, limit);
    return rows.map(row => JSON.parse(row.body));
  }
  updateRun(id, changes) {
    const run = this.getRun(id); if (!run) throw new DeskError('RUN_NOT_FOUND', 'Review run not found.', 404);
    Object.assign(run, changes, { updatedAt: nowIso() });
    this.db.prepare('UPDATE runs SET status=?,updated=?,body=? WHERE id=?').run(run.status, Date.now(), JSON.stringify(run), id);
    return run;
  }
  enqueue(pr, actor, config) {
    return this.transaction(() => {
      const active = this.db.prepare("SELECT COUNT(*) n FROM runs WHERE status IN ('queued','running','merging')").get().n;
      if (active >= config.maxActiveRuns) throw new DeskError('CAPACITY', 'Review capacity is busy. Wait for a running review to finish.', 429);
      if (this.db.prepare("SELECT 1 FROM runs WHERE pr=? AND status IN ('queued','running','merging')").get(pr.number)) throw new DeskError('RUN_IN_PROGRESS', 'This PR already has an active review.');
      const recent = this.db.prepare('SELECT COUNT(*) n FROM runs WHERE actor=? AND created>?').get(actor.id, Date.now() - 3_600_000).n;
      // Automatic checks (actor 'auto') follow every pushed change, so they get a larger budget.
      if (recent >= (actor.id === 'auto' ? config.maxRunsPerHour * 6 : config.maxRunsPerHour)) throw new DeskError('RATE_LIMIT', 'The hourly review limit has been reached.', 429);
      const run = { id: randomUUID(), prNumber: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha, baseBranch: pr.base.ref, reviewMode: config.reviewMode, status: 'queued', stage: 'queued', actor: actor.id, createdAt: nowIso(), updatedAt: nowIso(), ci: { status: 'pending', conclusion: null, url: null, runId: null }, reviews: [], error: null, dispatchAt: null, checkId: null };
      this.db.prepare('INSERT INTO runs(id,pr,status,actor,created,updated,body) VALUES(?,?,?,?,?,?,?)').run(run.id, run.prNumber, run.status, actor.id, Date.now(), Date.now(), JSON.stringify(run));
      this.audit(actor.id, 'review.queued', { runId: run.id, pr: pr.number, headSha: run.headSha, baseSha: run.baseSha, reviewMode: run.reviewMode });
      return run;
    });
  }
  lock(pr, owner, ttl = 120_000) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM locks WHERE expires<?').run(Date.now());
      try { this.db.prepare('INSERT INTO locks(pr,owner,expires) VALUES(?,?,?)').run(pr, owner, Date.now() + ttl); return true; } catch { return false; }
    });
  }
  unlock(pr, owner) { this.db.prepare('DELETE FROM locks WHERE pr=? AND owner=?').run(pr, owner); }
  renewLock(pr, owner, ttl = 120_000) { return this.db.prepare('UPDATE locks SET expires=? WHERE pr=? AND owner=? AND expires>?').run(Date.now() + ttl, pr, owner, Date.now()).changes > 0; }
  ownsLock(pr, owner) { return Boolean(this.db.prepare('SELECT 1 FROM locks WHERE pr=? AND owner=? AND expires>?').get(pr, owner, Date.now())); }
  claim(owner, ttl = 120_000) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id FROM runs WHERE status IN ('queued','running') AND lease_until<? ORDER BY created LIMIT 1").get(Date.now());
      if (!row) return null;
      this.db.prepare('UPDATE runs SET lease_owner=?,lease_until=? WHERE id=?').run(owner, Date.now() + ttl, row.id);
      return this.getRun(row.id);
    });
  }
  renew(id, owner, ttl = 120_000) { return this.db.prepare('UPDATE runs SET lease_until=? WHERE id=? AND lease_owner=? AND lease_until>?').run(Date.now() + ttl, id, owner, Date.now()).changes > 0; }
  ownsLease(id, owner) { return Boolean(this.db.prepare('SELECT 1 FROM runs WHERE id=? AND lease_owner=? AND lease_until>?').get(id, owner, Date.now())); }
  updateLeasedRun(id, owner, changes) {
    return this.transaction(() => {
      if (!this.ownsLease(id, owner)) throw new DeskError('LEASE_LOST', 'The worker lease expired; this process cannot alter the review.');
      return this.updateRun(id, changes);
    });
  }
  release(id, owner) { this.db.prepare('UPDATE runs SET lease_until=0,lease_owner=NULL WHERE id=? AND lease_owner=?').run(id, owner); }
  receive(deliveryId, event, payload) {
    return this.transaction(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO deliveries(id,received) VALUES(?,?)').run(deliveryId, Date.now());
      if (!inserted.changes) return false;
      if (['pull_request', 'workflow_run', 'check_run', 'push'].includes(event)) {
        const pr = payload.pull_request?.number ?? payload.number ?? null;
        const notification = { id: deliveryId, event, prNumber: Number.isInteger(pr) ? pr : null, title: event === 'pull_request' ? `PR #${pr} ${String(payload.action || 'updated').slice(0, 40)}` : `${event.replaceAll('_', ' ')} update`, createdAt: nowIso() };
        this.db.prepare('INSERT INTO notifications(id,created,body) VALUES(?,?,?)').run(deliveryId, Date.now(), JSON.stringify(notification));
        this.audit('github-webhook', 'webhook.received', { deliveryId, event, pr: notification.prNumber });
      }
      return true;
    });
  }
  notifications() { return this.db.prepare('SELECT body FROM notifications ORDER BY created DESC LIMIT 30').all().map(row => JSON.parse(row.body)); }
  recoverMerges() {
    const rows = this.db.prepare("SELECT runs.body FROM runs LEFT JOIN locks ON runs.pr=locks.pr WHERE runs.status='merging' AND (locks.expires IS NULL OR locks.expires<?)").all(Date.now());
    for (const row of rows) this.updateRun(JSON.parse(row.body).id, { status: 'merge_unknown', stage: 'manual_verification_required', error: 'The server restarted during merge. Check GitHub before taking another action.' });
  }
}
