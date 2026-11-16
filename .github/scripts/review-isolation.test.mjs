import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageReview, containerArguments } from './run-isolated-review.mjs';

const context = { scratch: '/scratch', source: '/scratch/source', user: '1001:1001', imageId: `sha256:${'a'.repeat(64)}`,
  tests: { 'apps/release-desk/server/tests': ['backend.test.mjs', 'new.test.mjs'] } };
const mounts = args => args.filter((value, index) => args[index - 1] === '--mount').map(value => value.replaceAll('\\', '/'));

test('every execution uses an isolated environment with read-only source and no host credentials', () => {
  for (const phase of ['install-theme', 'install-app', 'test-app', 'tokens', 'build-theme', 'build-app']) {
    const args = containerArguments(context, phase);
    assert(args.includes('--read-only'));
    assert(args.includes('--cap-drop=ALL'));
    assert(args.includes('--security-opt=no-new-privileges'));
    assert.equal(args[args.indexOf('--network') + 1], phase.startsWith('install-') ? 'bridge' : 'none');
    assert(mounts(args).includes('type=bind,source=/scratch/source,destination=/candidate,readonly'));
    assert(mounts(args).every(value => value.startsWith('type=bind,source=/scratch/')));
    assert(!args.includes('--env-file'));
    assert(!args.some(value => /GITHUB_|ANTHROPIC_|SHOPIFY_|docker\.sock|NODE_OPTIONS/.test(value)));
    assert.equal(args[args.indexOf(context.imageId) + 1], '-i');
    assert.equal(args[args.indexOf('--entrypoint') + 1], '/usr/bin/env');
  }
});

test('baseline tests remain explicit and source assets are writable only in the later build', () => {
  const appTests = containerArguments(context, 'test-app');
  assert.deepEqual(appTests.slice(-4), ['/usr/local/bin/node', '--test', 'server/tests/backend.test.mjs', 'server/tests/new.test.mjs']);
  assert(!mounts(appTests).some(value => value.includes('destination=/candidate/assets')));
  assert(mounts(appTests).filter(value => value.includes('dependencies')).every(value => value.endsWith(',readonly')));
  const build = containerArguments(context, 'build-theme');
  assert(mounts(build).some(value => value.endsWith('destination=/candidate/assets')));
  assert.deepEqual(build.slice(-3), ['/usr/local/bin/node', 'node_modules/vite/bin/vite.js', 'build']);
  assert(mounts(build).filter(value => value.includes('dependencies')).every(value => value.endsWith(',readonly')));
  assert.deepEqual(containerArguments(context, 'tokens').slice(-3), ['/usr/local/bin/node', 'scripts/tokens.mjs', '--check']);
});

test('dependency installation disables lifecycle scripts and only its own dependency mount is writable', () => {
  for (const phase of ['install-theme', 'install-app']) {
    const args = containerArguments(context, phase);
    assert.match(args.at(-1), /'ci', '--ignore-scripts', '--no-audit', '--no-fund'/);
    const writable = mounts(args).filter(value => !value.endsWith(',readonly'));
    assert.equal(writable.length, 1);
    assert(writable[0].includes(phase === 'install-theme' ? '/theme-dependencies,' : '/app-dependencies,'));
  }
});

test('staging restores removed baseline tests, replaces weakened ones, and retains new candidate tests', async t => {
  const base = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  await fs.mkdir(base, { recursive: true });
  const temp = await fs.mkdtemp(path.join(base, 'review-isolation-'));
  t.after(async () => { assert(temp.startsWith(base)); await fs.rm(temp, { recursive: true, force: true }); });
  const suite = 'apps/release-desk/server/tests';
  for (const tree of ['trusted', 'candidate']) for (const directory of [suite, 'assets']) await fs.mkdir(path.join(temp, tree, directory), { recursive: true });
  await fs.writeFile(path.join(temp, 'trusted', suite, 'baseline.test.mjs'), 'trusted regression');
  await fs.writeFile(path.join(temp, 'trusted', suite, 'deleted.test.mjs'), 'restored regression');
  await fs.writeFile(path.join(temp, 'candidate', suite, 'baseline.test.mjs'), 'weakened regression');
  await fs.writeFile(path.join(temp, 'candidate', suite, 'new.test.mjs'), 'new candidate regression');
  await fs.writeFile(path.join(temp, 'candidate/assets/main.js'), 'candidate implementation');
  const staged = await stageReview(path.join(temp, 'trusted'), path.join(temp, 'candidate'), path.join(temp, 'scratch'));
  assert.equal(await fs.readFile(path.join(staged.source, suite, 'baseline.test.mjs'), 'utf8'), 'trusted regression');
  assert.equal(await fs.readFile(path.join(staged.source, suite, 'deleted.test.mjs'), 'utf8'), 'restored regression');
  assert.equal(await fs.readFile(path.join(staged.source, 'assets/main.js'), 'utf8'), 'candidate implementation');
  assert.deepEqual(staged.tests[suite], ['baseline.test.mjs', 'deleted.test.mjs', 'new.test.mjs']);
  await fs.symlink(path.join(temp, 'trusted'), path.join(temp, 'candidate/linked-source'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageReview(path.join(temp, 'trusted'), path.join(temp, 'candidate'), path.join(temp, 'rejected')), /Symlinks are not supported/);
});
