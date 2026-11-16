import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { configuration } from '../config.mjs';
import { Store } from '../store.mjs';
import { Service } from '../service.mjs';
import { ConnectorStore } from '../connector-store.mjs';
import { createApp } from '../app.mjs';
import { readablePath, editablePath, editRefusal, changeId } from '../connector.mjs';

const sha = c => c.repeat(40);
function config() {
  return { ...configuration({ GITHUB_REPOSITORY: 'example-org/theme-repo', SHOP_DOMAIN: 'example-store.myshopify.com', APP_URL: 'https://desk.example', SHOPIFY_API_KEY: 'test-client-id', SHOPIFY_API_SECRET: 'test-only-secret-32-characters-long', SHOPIFY_REVIEWER_IDS: '42', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'x', GITHUB_INSTALLATION_ID: '456', GITHUB_WEBHOOK_SECRET: 'w', CLAUDE_REVIEW_MODE: 'demo' }) };
}
function fakeGitHub() {
  const files = new Map([['sections/hero.liquid', 'old hero'], ['assets/index.css', 'built'], ['config/settings_data.json', '{}'], ['.github/workflows/build.yml', 'ci'], ['README.md', '# readme']]);
  return {
    branches: new Map([['staging', sha('a')]]), commits: [], pulls: [], files,
    async branchSha(branch) { if (!this.branches.has(branch)) throw Object.assign(new Error('missing'), { code: 'GITHUB_ERROR' }); return this.branches.get(branch); },
    async tree() { return [...this.files.keys()].map(path => ({ path, size: this.files.get(path).length, sha: sha('f') })); },
    async readFile(path) { if (!this.files.has(path)) throw new Error('missing'); return { content: Buffer.from(this.files.get(path)), size: this.files.get(path).length }; },
    async createBranch(branch, from) { this.branches.set(branch, from); },
    async commitFiles(branch, input) { this.commits.push({ branch, ...input }); const next = sha(String(this.commits.length % 10)); this.branches.set(branch, next); return next; },
    async compareBranches(_base, head) { const branch = [...this.branches].find(([name, value]) => name.startsWith('claude/') && value === head)?.[0]; return { ahead_by: this.commits.filter(commit => commit.branch === branch).length }; },
    async createPull(input) { const pr = { number: 40 + this.pulls.length, html_url: `https://github.com/example-org/theme-repo/pull/${40 + this.pulls.length}`, state: 'open', merged: false, base: { ref: input.base }, ...input }; this.pulls.push(pr); return pr; },
    async getPull(number) { return this.pulls.find(pr => pr.number === number); },
    async pullCommits() { return []; },
  };
}
async function harness(t) {
  const cfg = config(), store = new Store(':memory:'), github = fakeGitHub(), connectorStore = new ConnectorStore(store);
  const service = new Service({ config: cfg, store, github, connectorStore });
  const app = createApp({ config: cfg, store, service, connectorStore, github, clientDir: '/nonexistent' });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { cfg, store, github, connectorStore, base };
}
async function session(cfg, sub = '42') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: `https://${cfg.shop}/admin`, dest: `https://${cfg.shop}`, aud: cfg.apiKey, sub, exp: now + 60, nbf: now - 1 }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(cfg.apiSecret));
}
async function connect(base, url) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url.replace('https://desk.example', base))));
  return client;
}
const call = async (client, name, args = {}) => { const result = await client.callTool({ name, arguments: args }); return { error: result.isError === true, text: result.content[0].text }; };

test('only theme folders are editable; built assets, store settings, CI and the app are not', () => {
  for (const path of ['sections/hero.liquid', 'snippets/a.liquid', 'templates/page.about.json', 'locales/nl.json', 'src/elements/main.js', 'config/settings_schema.json']) assert.ok(editablePath(path), path);
  for (const path of ['assets/index.css', 'assets/main.js', 'config/settings_data.json', 'config/markets.json', '.github/workflows/build.yml', 'apps/release-desk/server/app.mjs', 'package.json', '../secrets', 'sections/../.github/x', 'sections/.hidden', '/etc/passwd', 'sections\\hero.liquid']) assert.ok(!editablePath(path), path);
  assert.ok(readablePath('README.md') && !editablePath('README.md'));
  assert.match(editRefusal('assets/index.css'), /src\//);
  assert.match(changeId('Groene knoppen op de PDP!'), /^groene-knoppen-op-de-pdp-[a-f0-9]{6}$/);
});

test('connections are created only by authenticated reviewers, shown once, stored hashed and revocable', async t => {
  const { cfg, base, store } = await harness(t);
  const post = async (sub, body) => fetch(`${base}/api/connections`, { method: 'POST', headers: { Authorization: `Bearer ${await session(cfg, sub)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/api/connections`, { method: 'POST' })).status, 401);
  assert.equal((await post('43', { name: 'Reader', email: 'r@example.com' })).status, 403);
  assert.equal((await post('42', { name: 'X', email: 'not-an-email' })).status, 400);
  const created = await (await post('42', { name: 'Sam', email: 'sam@example.com' })).json();
  assert.match(created.url, /^https:\/\/desk\.example\/mcp\/rdc_[A-Za-z0-9_-]{43}$/);
  const token = created.url.split('/').pop();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM connections WHERE token_hash=?').get(Buffer.from(token)).n, 0, 'the raw token is never stored');
  const list = await (await fetch(`${base}/api/connections`, { headers: { Authorization: `Bearer ${await session(cfg)}` } })).json();
  assert.equal(list.connections.length, 1); assert.ok(!JSON.stringify(list).includes(token));
  const del = await fetch(`${base}/api/connections/${created.connection.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await session(cfg)}` } });
  assert.equal(del.status, 200);
  const rejected = await fetch(created.url.replace('https://desk.example', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
  assert.equal(rejected.status, 401, 'a revoked connection is refused');
});

test('unknown or malformed connector tokens are refused before any tool runs', async t => {
  const { base } = await harness(t);
  for (const token of ['nope', `rdc_${'a'.repeat(43)}`]) {
    const response = await fetch(`${base}/mcp/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
  }
});

test('Claude reads staging, changes only its own claude/ branch, commits under the person and opens a PR into staging', async t => {
  const { base, github, connectorStore } = await harness(t);
  const url = `https://desk.example/mcp/${connectorStore.create({ id: '42' }, { name: 'Sam de Smit', email: 'sam@example.com' }).token}`;
  const client = await connect(base, url);
  const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ['change_status', 'get_started', 'list_changes', 'list_files', 'read_file', 'save_files', 'start_change', 'submit_change']);
  assert.ok(!tools.some(name => /merge|release|publish|push|live/.test(name)), 'no tool can merge or release');
  assert.match((await call(client, 'get_started')).text, /Sam de Smit/);
  const listing = (await call(client, 'list_files')).text;
  assert.match(listing, /sections\/hero\.liquid/); assert.match(listing, /assets\/index\.css .*\[read-only\]/); assert.doesNotMatch(listing, /\.github/);
  assert.equal((await call(client, 'read_file', { path: '.github/workflows/build.yml' })).error, true);
  assert.equal((await call(client, 'read_file', { path: 'sections/hero.liquid' })).text, 'old hero');

  const started = JSON.parse((await call(client, 'start_change', { title: 'Groene hero', request: 'Maak de hero groen' })).text);
  assert.match(started.branch, /^claude\/groene-hero-[a-f0-9]{6}$/);
  assert.equal((await call(client, 'submit_change', { change_id: started.change_id, summary: 'x' })).error, true, 'cannot submit an empty change');
  for (const path of ['assets/index.css', 'config/settings_data.json', '.github/workflows/build.yml', 'package.json']) {
    const refused = await call(client, 'save_files', { change_id: started.change_id, message: 'try', files: [{ path, content: 'x' }] });
    assert.equal(refused.error, true, path);
  }
  assert.equal((await call(client, 'save_files', { change_id: started.change_id, message: 'bad json', files: [{ path: 'templates/index.json', content: '{oops' }] })).error, true);
  assert.equal(github.commits.length, 0, 'refused saves never reach GitHub');

  const saved = JSON.parse((await call(client, 'save_files', { change_id: started.change_id, message: 'Hero groen', files: [{ path: 'sections/hero.liquid', content: 'green hero' }] })).text);
  assert.equal(github.commits.length, 1);
  assert.equal(github.commits[0].branch, started.branch);
  assert.deepEqual(github.commits[0].author, { name: 'Sam de Smit', email: 'sam@example.com' });
  assert.match(github.commits[0].message, /Requested by Sam de Smit via Claude/);
  assert.ok(saved.commit);

  const submitted = JSON.parse((await call(client, 'submit_change', { change_id: started.change_id, summary: 'Hero achtergrond groen gemaakt.' })).text);
  assert.equal(submitted.pull_request, 40);
  assert.equal(github.pulls[0].base, 'staging'); assert.equal(github.pulls[0].head, started.branch);
  assert.match(github.pulls[0].body, /Requested by Sam de Smit via Claude/); assert.match(github.pulls[0].body, /Maak de hero groen/);
  assert.equal(connectorStore.changeForPull(40).name, 'Sam de Smit');
  assert.match((await call(client, 'change_status', { change_id: started.change_id })).text, /"status": "open"/);
  await client.close();
});

test('one person cannot read or change another person\'s change', async t => {
  const { base, connectorStore, github } = await harness(t);
  const a = connectorStore.create({ id: '42' }, { name: 'A', email: 'a@example.com' }).token;
  const b = connectorStore.create({ id: '77' }, { name: 'B', email: 'b@example.com' }).token;
  const clientA = await connect(base, `https://desk.example/mcp/${a}`), clientB = await connect(base, `https://desk.example/mcp/${b}`);
  const started = JSON.parse((await call(clientA, 'start_change', { title: 'Mine', request: 'mine' })).text);
  for (const [tool, args] of [['save_files', { change_id: started.change_id, message: 'x', files: [{ path: 'sections/hero.liquid', content: 'b' }] }], ['submit_change', { change_id: started.change_id, summary: 'x' }], ['read_file', { path: 'sections/hero.liquid', change_id: started.change_id }], ['change_status', { change_id: started.change_id }]]) {
    assert.equal((await call(clientB, tool, args)).error, true, tool);
  }
  assert.equal(github.commits.length, 0);
  assert.equal(JSON.parse((await call(clientB, 'list_changes')).text).length, 0);
  await clientA.close(); await clientB.close();
});

test('write budget is enforced per connection', async t => {
  const { connectorStore } = await harness(t);
  const { connection } = connectorStore.create({ id: '42' }, { name: 'A', email: 'a@example.com' });
  for (let i = 0; i < 3; i++) assert.ok(connectorStore.allow(connection.id, true, { writes: 3 }));
  assert.equal(connectorStore.allow(connection.id, true, { writes: 3 }), false);
  assert.ok(connectorStore.allow(connection.id, false, { writes: 3 }), 'reads have their own budget');
});
