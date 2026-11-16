import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../config.mjs';
import { buildPreviewTheme } from '../preview-builder.mjs';
import { PreviewTransport, previewThemeName } from '../preview-transport.mjs';

const head = 'a'.repeat(40);
const code = () => new Map([
  ['layout/theme.liquid', '{{ content_for_layout }}'],
  ['sections/hero.liquid', 'new hero'],
  ['templates/index.json', '{"sections":{"pr":{"type":"hero"}},"order":["pr"]}'],
  ['templates/page.new-landing.json', '{"sections":{},"order":[]}'],
  ['config/settings_data.json', '{"current":"repository"}'],
  ['assets/.gitkeep', ''],
]);
const live = () => new Map([
  ['templates/index.json', '{"sections":{"live":{"type":"hero"}},"order":["live"]}'],
  ['config/settings_data.json', '{"current":"live"}'],
]);

test('preview theme is the PR code with the live store content laid over it', () => {
  const built = buildPreviewTheme({ codeFiles: code(), storeFiles: live(), changedFiles: [{ filename: 'sections/hero.liquid' }] });
  assert.equal(built.files.get('sections/hero.liquid'), 'new hero');
  assert.match(built.files.get('templates/index.json'), /"live"/);
  assert.match(built.files.get('config/settings_data.json'), /"live"/);
  assert.ok(built.files.has('templates/page.new-landing.json'), 'a template that is new in the PR comes through');
  assert.ok(!built.files.has('assets/.gitkeep'));
  assert.deepEqual(built.targets, [{ label: 'Homepage', path: '/' }]);
  assert.deepEqual(built.notes, []);
});

test('preview notes explain live content wins and missing compiled assets', () => {
  const built = buildPreviewTheme({ codeFiles: code(), storeFiles: live(), changedFiles: [{ filename: 'templates/index.json' }, { filename: 'src/elements/main.js' }, { filename: 'templates/cart.json' }] });
  assert.equal(built.notes.length, 2);
  assert.deepEqual(built.targets.map(target => target.path), ['/', '/cart']);
  const compiled = buildPreviewTheme({ codeFiles: code(), storeFiles: live(), changedFiles: [{ filename: 'src/elements/main.js' }, { filename: 'assets/main.js' }] });
  assert.equal(compiled.notes.length, 0);
});

test('preview builder refuses unsafe paths and incomplete themes', () => {
  for (const file of ['../evil.liquid', 'sections/../../x.liquid', 'other/file.liquid', 'sections/a b.liquid']) {
    const files = code(); files.set(file, 'x');
    assert.throws(() => buildPreviewTheme({ codeFiles: files, storeFiles: live() }), { code: 'PREVIEW_BUILD_INVALID' });
  }
  const files = code(); files.delete('layout/theme.liquid');
  assert.throws(() => buildPreviewTheme({ codeFiles: files, storeFiles: live() }), /layout\/theme\.liquid/);
});

function transportFixture(t, themes) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'release-desk-preview-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = { ...configuration({ SHOP_DOMAIN: 'example-store.myshopify.com', GITHUB_REPOSITORY: 'example-org/theme-repo', SHOPIFY_THEME_TOKEN: 'shptka_fixture', DATA_DIR: dataDir }) };
  const calls = [];
  const runCli = async (_binary, args, options) => {
    calls.push({ args, env: options.env });
    if (args[1] === 'list') return themes;
    if (args[1] === 'push') { const theme = { id: 31, name: previewThemeName(7), role: 'unpublished' }; themes.push(theme); return { status: 'success', theme }; }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { transport: new PreviewTransport({ config, github: {}, runCli }), calls };
}

test('preview upload targets only the configured store, an unpublished theme and never live flags', async t => {
  const { transport, calls } = transportFixture(t, [{ id: 1, name: 'Live', role: 'live' }]);
  assert.equal(transport.configured(), true);
  const result = await transport.pushTheme({ market: 'store', prNumber: 7, headSha: head, files: new Map([['layout/theme.liquid', 'x']]) });
  assert.deepEqual(result, { themeId: '31', previewUrl: 'https://example-store.myshopify.com/?preview_theme_id=31' });
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('--store') + 1], 'example-store.myshopify.com');
    assert(!call.args.some(arg => ['--live', '--allow-live', '--publish'].includes(arg)));
    assert.equal(call.env.SHOPIFY_CLI_THEME_TOKEN, 'shptka_fixture');
    assert(!call.args.includes('shptka_fixture'), 'the token never appears in argv');
  }
  const push = calls.find(call => call.args[1] === 'push');
  assert.deepEqual(push.args.slice(2, 5), ['--unpublished', '--theme', 'Release Desk PR 7']);
});

test('preview upload refuses a theme with the reserved name that is live', async t => {
  const { transport, calls } = transportFixture(t, [{ id: 1, name: previewThemeName(7), role: 'live' }]);
  await assert.rejects(transport.pushTheme({ market: 'store', prNumber: 7, headSha: head, files: new Map([['layout/theme.liquid', 'x']]) }), { code: 'PREVIEW_LIVE_REFUSED' });
  assert(!calls.some(call => call.args[1] === 'push'));
});

test('preview code download reads only root theme folders, verified against git blob hashes', async t => {
  const blob = text => { const bytes = Buffer.from(text); return { bytes, sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }; };
  const liquid = blob('{{ content_for_layout }}'), readme = blob('# readme');
  const tree = { truncated: false, tree: [
    { path: 'layout/theme.liquid', type: 'blob', mode: '100644', sha: liquid.sha, size: liquid.bytes.length },
    { path: 'README.md', type: 'blob', mode: '100644', sha: readme.sha, size: readme.bytes.length },
    { path: 'apps/release-desk/server/index.mjs', type: 'blob', mode: '100644', sha: readme.sha, size: readme.bytes.length },
  ] };
  const github = { route: suffix => suffix, request: async (_method, route) => route.startsWith('git/trees/') ? tree : { sha: liquid.sha, encoding: 'base64', content: liquid.bytes.toString('base64') } };
  const { transport } = transportFixture(t, []);
  transport.github = github;
  const files = await transport.getCode(head);
  assert.deepEqual([...files.keys()], ['layout/theme.liquid']);
});
