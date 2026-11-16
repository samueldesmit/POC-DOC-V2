import { randomUUID } from 'node:crypto';
import { DeskError, nowIso } from './errors.mjs';

// Preview records have no relationship to passing reviews or merge authorization.
export class PreviewStore {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY, pr INTEGER NOT NULL, head TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_preview ON previews((1)) WHERE status IN ('queued','running');
      CREATE TABLE IF NOT EXISTS preview_themes(pr INTEGER NOT NULL, market TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(pr,market));
    `);
  }
  get(id) { const row = this.db.prepare('SELECT body FROM previews WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; }
  latest(number) { const row = this.db.prepare('SELECT body FROM previews WHERE pr=? ORDER BY created DESC,rowid DESC LIMIT 1').get(number); return row ? JSON.parse(row.body) : null; }
  update(id, changes) {
    const job = this.get(id); if (!job) throw new DeskError('PREVIEW_NOT_FOUND', 'Preview job not found.', 404);
    Object.assign(job, changes, { updatedAt: nowIso() });
    this.db.prepare('UPDATE previews SET status=?,updated=?,body=? WHERE id=?').run(job.status, Date.now(), JSON.stringify(job), id);
    return job;
  }
  enqueue(pr, actor, config) {
    return this.store.transaction(() => {
      const active = this.db.prepare("SELECT body FROM previews WHERE status IN ('queued','running') LIMIT 1").get();
      if (active) {
        const existing = JSON.parse(active.body);
        if (existing.prNumber === pr.number && existing.headSha === pr.head.sha && existing.baseSha === pr.base.sha) return existing;
        throw new DeskError('PREVIEW_BUSY', 'Another store preview is being generated. Refresh its status before starting another.', 429);
      }
      const recent = this.db.prepare('SELECT COUNT(*) n FROM previews WHERE actor=? AND created>?').get(actor.id, Date.now() - 3_600_000).n;
      if (recent >= config.maxPreviewsPerHour) throw new DeskError('PREVIEW_RATE_LIMIT', 'The hourly preview limit has been reached.', 429);
      const job = { id: randomUUID(), prNumber: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha, status: 'queued', createdAt: nowIso(), updatedAt: nowIso(), markets: [{ market: 'store', status: 'queued', links: [] }], notes: [], error: null };
      this.db.prepare('INSERT INTO previews(id,pr,head,status,actor,created,updated,body) VALUES(?,?,?,?,?,?,?,?)').run(job.id, job.prNumber, job.headSha, job.status, actor.id, Date.now(), Date.now(), JSON.stringify(job));
      this.store.audit(actor.id, 'preview.queued', { previewId: job.id, pr: job.prNumber, headSha: job.headSha, baseSha: job.baseSha });
      return job;
    });
  }
  claim(owner, ttl = 120_000) {
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT id FROM previews WHERE status IN ('queued','running') AND lease_until<? ORDER BY created LIMIT 1").get(Date.now());
      if (!row) return null;
      this.db.prepare('UPDATE previews SET lease_owner=?,lease_until=? WHERE id=?').run(owner, Date.now() + ttl, row.id);
      return this.get(row.id);
    });
  }
  nextLeaseExpiry() { return this.db.prepare("SELECT MIN(lease_until) expiry FROM previews WHERE status IN ('queued','running')").get().expiry; }
  owns(id, owner) { return Boolean(this.db.prepare('SELECT 1 FROM previews WHERE id=? AND lease_owner=? AND lease_until>?').get(id, owner, Date.now())); }
  renew(id, owner, ttl = 120_000) { return this.db.prepare('UPDATE previews SET lease_until=? WHERE id=? AND lease_owner=? AND lease_until>?').run(Date.now() + ttl, id, owner, Date.now()).changes > 0; }
  release(id, owner) { this.db.prepare('UPDATE previews SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?').run(id, owner); }
  updateLeased(id, owner, changes) {
    return this.store.transaction(() => {
      if (!this.owns(id, owner)) throw new DeskError('PREVIEW_LEASE_LOST', 'The preview job is being handled by another worker.');
      return this.update(id, changes);
    });
  }
  theme(number, market) { const row = this.db.prepare('SELECT body FROM preview_themes WHERE pr=? AND market=?').get(number, market); return row ? JSON.parse(row.body) : null; }
  saveTheme(number, market, value) { this.db.prepare('INSERT INTO preview_themes(pr,market,body) VALUES(?,?,?) ON CONFLICT(pr,market) DO UPDATE SET body=excluded.body').run(number, market, JSON.stringify(value)); }
}
