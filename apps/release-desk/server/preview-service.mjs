import { createHash, randomUUID } from 'node:crypto';
import { DeskError, ensure, isSha, safeError } from './errors.mjs';
import { validatePull } from './github.mjs';
import { buildPreviewTheme } from './preview-builder.mjs';

import { PREVIEW_MARKET } from './preview-transport.mjs';

const STALE = new Set(['STALE_HEAD', 'STALE_BASE', 'PR_INELIGIBLE', 'PR_SCOPE']);

function buildDigest(files) {
  const hash = createHash('sha256');
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = Buffer.from(content);
    hash.update(`${name.length}:${name}:${bytes.length}:`); hash.update(bytes);
  }
  return hash.digest('hex');
}

function targetLinks(previewUrl, themeId, targets, shop) {
  const base = new URL(previewUrl);
  ensure(base.protocol === 'https:' && base.hostname === shop && !base.username && !base.password && !base.port, 'PREVIEW_URL', 'Shopify returned an unexpected preview URL.', 502);
  ensure(/^\d+$/.test(String(themeId)), 'PREVIEW_THEME', 'Shopify returned an invalid preview theme.', 502);
  return targets.map(target => {
    ensure(typeof target.path === 'string' && target.path.startsWith('/') && !target.path.startsWith('//'), 'PREVIEW_PATH', 'The preview target path is invalid.', 422);
    const url = new URL(target.path, base.origin);
    ensure(url.origin === base.origin, 'PREVIEW_PATH', 'The preview target must belong to this store.', 422);
    for (const [key, value] of base.searchParams) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    url.searchParams.set('preview_theme_id', String(themeId));
    return { label: String(target.label), url: url.href };
  });
}

export class PreviewService {
  constructor({ config, store, previewStore, github, transport, builder = buildPreviewTheme }) {
    Object.assign(this, { config, store, previewStore, github, transport, builder });
    this.owner = randomUUID(); this.busy = false; this.stopped = false;
  }
  configured() { return Boolean(this.transport?.configured()); }
  status(number) {
    let previews = this.previewStore.latest(number);
    // Expose links only after both uploads and the final revision check settle.
    if (previews && ['queued', 'running'].includes(previews.status)) previews = { ...previews, markets: previews.markets.map(market => ({ ...market, links: [] })) };
    return { previews, configured: this.configured() };
  }
  async generate(number, headSha, actor) {
    ensure(actor.canMutate, 'FORBIDDEN', 'Your Shopify user is not authorized to generate previews.', 403);
    ensure(isSha(headSha), 'INVALID_SHA', 'Supply the full PR head SHA.', 400);
    ensure(this.configured(), 'PREVIEW_UNAVAILABLE', 'Theme access for the store must be configured before generating previews.', 503);
    const pr = await this.github.getPull(number); validatePull(pr, this.config, headSha);
    // Previews render this PR's immutable comparison, including PRs behind main.
    // They do not grant release approval; review and merge keep their strict main checks.
    this.previewStore.enqueue(pr, actor, this.config);
    this.resume();
    return this.status(number);
  }
  resume() {
    if (this.stopped || this.busy) return;
    clearTimeout(this.wakeTimer);
    queueMicrotask(() => void this.drain());
  }
  stop() { this.stopped = true; clearTimeout(this.wakeTimer); }
  async drain() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped) {
        const job = this.previewStore.claim(this.owner);
        if (!job) {
          const expiry = this.previewStore.nextLeaseExpiry();
          if (expiry !== null) {
            this.wakeTimer = setTimeout(() => this.resume(), Math.max(25, expiry - Date.now() + 25));
            this.wakeTimer.unref();
          }
          break;
        }
        const heartbeat = setInterval(() => this.previewStore.renew(job.id, this.owner), 30_000); heartbeat.unref();
        try { await this.process(job); }
        catch (error) {
          if (!this.stopped && this.previewStore.owns(job.id, this.owner)) {
            const current = this.previewStore.get(job.id);
            this.previewStore.updateLeased(job.id, this.owner, { status: 'failed', error: safeError(error), errorCode: error instanceof DeskError ? error.code : 'PREVIEW_FAILED', markets: current.markets.map(market => ({ ...market, status: 'failed', links: [], error: safeError(error) })) });
            this.store.audit('preview-worker', 'preview.failed', { previewId: job.id, code: error.code || 'UPSTREAM_ERROR' });
          }
        } finally { clearInterval(heartbeat); this.previewStore.release(job.id, this.owner); }
      }
    } catch { /* Keep durable job state for recovery after a storage failure. Never expose unverified links. */ }
    finally { this.busy = false; }
  }
  assertActive(job) {
    ensure(!this.stopped, 'PREVIEW_STOPPED', 'The preview service is restarting.');
    ensure(Date.now() - Date.parse(job.createdAt) < this.config.maxPreviewMs, 'PREVIEW_TIMEOUT', 'Preview generation exceeded its time limit.');
    ensure(this.previewStore.owns(job.id, this.owner), 'PREVIEW_LEASE_LOST', 'The preview job is being handled by another worker.');
  }
  async verifyRevision(job) {
    const pr = await this.github.getPull(job.prNumber); validatePull(pr, this.config, job.headSha, job.baseSha);
    this.assertActive(job);
  }
  async process(job) {
    this.assertActive(job);
    ensure(this.configured(), 'PREVIEW_UNAVAILABLE', 'Theme access for the store is not configured.', 503);
    const update = changes => this.previewStore.updateLeased(job.id, this.owner, changes);
    update({ status: 'running', error: null });
    await this.verifyRevision(job);
    const changedFiles = await this.github.immutableFiles(job.baseSha, job.headSha);
    const codeFiles = await this.transport.getCode(job.headSha);
    const markets = [], notes = new Set();
    for (const market of [PREVIEW_MARKET]) {
      this.assertActive(job);
      update({ markets: [...markets, { market, status: 'running', links: [] }, ...[PREVIEW_MARKET].slice(markets.length + 1).map(next => ({ market: next, status: 'queued', links: [] }))] });
      try {
        // Always read current store configuration, even when the exact head was previewed before.
        const snapshot = await this.transport.getStoreFiles(market);
        this.assertActive(job);
        const built = this.builder({ codeFiles, storeFiles: snapshot.files, changedFiles, prNumber: job.prNumber, headSha: job.headSha, market });
        for (const note of built.notes || []) notes.add(note);
        await this.verifyRevision(job);
        if (!built.targets.length) {
          markets.push({ market, status: 'unavailable', links: [], settingsDigest: built.settingsDigest });
          continue;
        }
        const previous = this.previewStore.theme(job.prNumber, market);
        const targetsDigest = createHash('sha256').update(JSON.stringify(built.targets)).digest('hex');
        const materializedDigest = buildDigest(built.files);
        const previousUnpublished = previous && this.transport.isUnpublishedTheme ? await this.transport.isUnpublishedTheme({ market, themeId: previous.themeId, prNumber: job.prNumber }) : false;
        const reusable = previousUnpublished && previous.headSha === job.headSha && previous.baseSha === job.baseSha && previous.settingsDigest === built.settingsDigest && previous.targetsDigest === targetsDigest && previous.buildDigest === materializedDigest && String(previous.themeId) !== String(snapshot.liveThemeId);
        this.assertActive(job);
        let result = reusable ? previous : null;
        if (!result) {
          result = await this.transport.pushTheme({ market, prNumber: job.prNumber, headSha: job.headSha, files: built.files, ...(previousUnpublished ? { themeId: previous.themeId } : {}) });
          this.assertActive(job);
          ensure(String(result.themeId) !== String(snapshot.liveThemeId), 'PREVIEW_LIVE_THEME', 'The preview uploader returned the live theme. No preview link was accepted.', 502);
        }
        const links = targetLinks(result.previewUrl, result.themeId, built.targets, this.config.shop);
        this.previewStore.saveTheme(job.prNumber, market, { themeId: result.themeId, previewUrl: result.previewUrl, headSha: job.headSha, baseSha: job.baseSha, settingsDigest: built.settingsDigest, targetsDigest, buildDigest: materializedDigest });
        markets.push({ market, status: 'ready', links, themeId: String(result.themeId), settingsDigest: built.settingsDigest, cached: Boolean(reusable) });
      } catch (error) {
        if (STALE.has(error.code) || ['PREVIEW_LEASE_LOST', 'PREVIEW_TIMEOUT', 'PREVIEW_STOPPED'].includes(error.code)) throw error;
        markets.push({ market, status: 'failed', links: [], error: safeError(error), errorCode: error instanceof DeskError ? error.code : 'PREVIEW_FAILED' });
      }
      update({ markets: [...markets, ...[PREVIEW_MARKET].slice(markets.length).map(next => ({ market: next, status: 'queued', links: [] }))], notes: [...notes] });
    }
    // A head update during upload invalidates the links.
    await this.verifyRevision(job);
    const ready = markets.filter(market => market.status === 'ready').length;
    const status = ready === 1 ? 'ready' : ready ? 'partial' : markets.some(market => market.status === 'failed') ? 'failed' : 'unavailable';
    update({ status, markets, notes: [...notes], error: status === 'failed' ? 'Store previews could not be generated. See the individual store results.' : null });
    this.store.audit('preview-worker', 'preview.completed', { previewId: job.id, status, headSha: job.headSha });
  }
}
