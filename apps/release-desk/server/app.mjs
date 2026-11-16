import express from 'express';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authenticate, verifyWebhook } from './auth.mjs';
import { DeskError, ensure } from './errors.mjs';

export function createApp({ config, store, service, clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/client') }) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', `frame-ancestors https://${config.shop} https://admin.shopify.com; object-src 'none'; base-uri 'self'`);
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/webhooks/github', express.raw({ type: 'application/json', limit: '2mb' }), (req, res) => {
    ensure(verifyWebhook(req.body, req.get('x-hub-signature-256'), config.webhookSecret), 'WEBHOOK_SIGNATURE', 'Invalid webhook signature.', 401);
    const id = req.get('x-github-delivery'), event = req.get('x-github-event');
    ensure(typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id) && typeof event === 'string' && /^[a-z_]{1,50}$/.test(event), 'WEBHOOK_HEADERS', 'Invalid webhook headers.', 400);
    let payload; try { payload = JSON.parse(req.body.toString('utf8')); } catch { throw new DeskError('INVALID_JSON', 'Invalid JSON.', 400); }
    ensure(payload.repository?.full_name === config.repository || event === 'ping', 'WEBHOOK_REPOSITORY', 'Unexpected repository.', 403);
    res.json({ received: true, duplicate: !store.receive(id, event, payload) });
  });
  app.use('/api', async (req, _res, next) => { req.actor = await authenticate(req.get('authorization'), config); next(); });
  app.use('/api', express.json({ limit: '8kb', strict: true }));
  app.get('/api/dashboard', async (req, res) => res.json(await service.dashboard(req.actor)));
  app.param('number', (req, _res, next, value) => { ensure(/^[1-9]\d{0,8}$/.test(value), 'INVALID_PR', 'Invalid PR number.', 400); req.prNumber = Number(value); next(); });
  app.get('/api/pulls/:number', async (req, res) => res.json(await service.detail(req.prNumber)));
  app.get('/api/pulls/:number/previews', (req, res) => res.json(service.previewsStatus(req.prNumber)));
  app.post('/api/pulls/:number/previews', async (req, res) => { ensure(req.is('application/json'), 'CONTENT_TYPE', 'JSON is required.', 415); res.status(202).json(await service.generatePreviews(req.prNumber, req.body?.headSha, req.actor)); });
  app.get('/api/runs/:id', (req, res) => { const run = store.getRun(req.params.id); ensure(run, 'RUN_NOT_FOUND', 'Review run not found.', 404); res.json({ run }); });
  app.post('/api/pulls/:number/test', async (req, res) => { ensure(req.is('application/json'), 'CONTENT_TYPE', 'JSON is required.', 415); res.status(202).json({ run: await service.test(req.prNumber, req.body?.headSha, req.actor) }); });
  app.post('/api/pulls/:number/merge', async (req, res) => { ensure(req.is('application/json'), 'CONTENT_TYPE', 'JSON is required.', 415); res.json(await service.merge(req.prNumber, req.body || {}, req.actor)); });
  app.post('/api/release', async (req, res) => { ensure(req.is('application/json'), 'CONTENT_TYPE', 'JSON is required.', 415); res.json(await service.createRelease(req.actor)); });
  app.post('/api/pulls/:number/reconcile', async (req, res) => { ensure(req.is('application/json'), 'CONTENT_TYPE', 'JSON is required.', 415); res.json({ run: await service.reconcile(req.prNumber, req.body?.runId, req.actor) }); });
  app.use('/api', (_req, _res) => { throw new DeskError('NOT_FOUND', 'API endpoint not found.', 404); });
  if (existsSync(path.join(clientDir, 'index.html'))) {
    app.use('/assets', express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
    app.get('/{*path}', (_req, res) => {
      const key = config.apiKey.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      res.type('html').send(readFileSync(path.join(clientDir, 'index.html'), 'utf8').replaceAll('__SHOPIFY_API_KEY__', key));
    });
  }
  app.use((error, req, res, _next) => {
    const known = error instanceof DeskError;
    const status = known ? error.status : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    if (req.actor) store.audit(req.actor.id, 'request.rejected', { method: req.method, path: req.path.slice(0, 200), code: known ? error.code : 'REQUEST_ERROR' });
    res.status(status).json({ error: { code: known ? error.code : 'REQUEST_ERROR', message: known ? error.message : 'The request could not be processed.' } });
  });
  return app;
}
