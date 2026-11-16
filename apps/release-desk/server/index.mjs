import path from 'node:path';
import { configuration } from './config.mjs';
import { Store } from './store.mjs';
import { GitHub } from './github.mjs';
import { Reviews } from './reviews.mjs';
import { Service } from './service.mjs';
import { Worker } from './worker.mjs';
import { createApp } from './app.mjs';
import { PreviewStore } from './preview-store.mjs';
import { PreviewService } from './preview-service.mjs';
import { PreviewTransport } from './preview-transport.mjs';
import { ConnectorStore } from './connector-store.mjs';
import { Flow } from './flow.mjs';
import { Brand } from './brand.mjs';

const config = configuration();
const store = new Store(path.join(config.dataDir, 'release-desk.sqlite'));
const github = new GitHub(config), reviews = new Reviews(config);
const previewStore = new PreviewStore(store);
const previewService = new PreviewService({ config, store, previewStore, github, transport: new PreviewTransport({ config, github }) });
const connectorStore = new ConnectorStore(store);
const service = new Service({ config, store, github, previewService, connectorStore });
const worker = new Worker({ config, store, github, reviews });
const flow = new Flow({ config, store, github, service });
service.flow = flow;
worker.onFinished = run => flow.onRunFinished(run);
const app = createApp({ config, store, service, connectorStore, github, flow, brand: new Brand({ config, github }) });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'server.started', port: config.port })); worker.start(); previewService.resume();
});
function shutdown() { worker.stop(); previewService.stop(); server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); }
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
