import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const image = 'node:22-bookworm';
// Kickstarter themes have no theme test suite; the app's regressions are pinned from the trusted branch.
const suites = ['apps/release-desk/server/tests'];
const executable = '/usr/local/bin/node';
const writablePaths = ['.tmp', 'assets', 'apps/release-desk/.tmp', 'apps/release-desk/dist'];

async function copySource(source, destination, relative = '') {
  const stat = await fs.lstat(source);
  assert(!stat.isSymbolicLink(), `Symlinks are not supported in review source: ${relative}`);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) {
      if (name === '.git' || name === 'node_modules') continue;
      await copySource(path.join(source, name), path.join(destination, name), path.posix.join(relative, name));
    }
  } else {
    assert(stat.isFile(), `Non-regular review source: ${relative}`);
    await fs.copyFile(source, destination);
  }
}

export async function stageReview(trusted, candidate, scratch) {
  const source = path.join(scratch, 'source');
  await copySource(candidate, source);
  const tests = {};
  for (const directory of suites) {
    const target = path.join(source, directory);
    await fs.mkdir(target, { recursive: true });
    const baseline = (await fs.readdir(path.join(trusted, directory))).filter(name => name.endsWith('.test.mjs'));
    assert(baseline.length, `Trusted regression suite is missing: ${directory}`);
    for (const name of baseline) {
      assert((await fs.lstat(path.join(trusted, directory, name))).isFile(), 'Baseline tests must be regular files');
      await fs.copyFile(path.join(trusted, directory, name), path.join(target, name));
    }
    tests[directory] = (await fs.readdir(target)).filter(name => name.endsWith('.test.mjs')).sort();
    assert(tests[directory].every(name => /^[a-zA-Z0-9_.-]+\.test\.mjs$/.test(name)), 'Unsupported test filename');
  }
  // All mount targets exist before any candidate process starts. Source and
  // test ancestors are read-only, so renaming a parent cannot evade protection.
  for (const relative of [...writablePaths, 'node_modules', 'node_modules/.vite-temp', 'apps/release-desk/node_modules', 'apps/release-desk/node_modules/.vite-temp']) {
    await fs.mkdir(path.join(source, relative), { recursive: true });
  }
  return { scratch, source, tests };
}

function mount(source, destination, readonly = true) {
  assert(!source.includes(',') && !destination.includes(','), 'Docker mount paths must not contain commas');
  return ['--mount', `type=bind,source=${source},destination=${destination}${readonly ? ',readonly' : ''}`];
}

export function containerArguments(context, phase) {
  const { source, scratch, imageId = image, user = '1000:1000' } = context;
  const install = phase.startsWith('install-');
  const app = phase.endsWith('-app');
  const build = phase.startsWith('build-');
  const args = ['run', '--rm', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user', user, '--cpus=2', '--memory=4g', '--memory-swap=4g', '--pids-limit=256',
    '--ulimit', 'nofile=1024:1024', '--ulimit', 'fsize=1073741824:1073741824',
    '--network', install ? 'bridge' : 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,size=1073741824,mode=1777',
    '--workdir', app ? '/candidate/apps/release-desk' : '/candidate',
    ...mount(source, '/candidate')];
  for (const [folder, destination] of [['theme-dependencies', '/candidate/node_modules'], ['app-dependencies', '/candidate/apps/release-desk/node_modules']]) {
    const writable = install && (app ? folder === 'app-dependencies' : folder === 'theme-dependencies');
    args.push(...mount(path.join(scratch, folder), destination, !writable));
  }
  // Builds get disposable output copies; tests always read the exact source
  // assets. No candidate process can change what subsequent tests execute.
  const outputs = phase.startsWith('test-') ? (app ? ['apps/release-desk/.tmp'] : ['.tmp'])
    : build ? (app ? ['apps/release-desk/dist'] : ['assets']) : [];
  for (const relative of outputs) args.push(...mount(path.join(scratch, 'output', relative), `/candidate/${relative}`, false));
  if (build) args.push(...mount(path.join(scratch, app ? 'app-vite-cache' : 'theme-vite-cache'), `/candidate/${app ? 'apps/release-desk/' : ''}node_modules/.vite-temp`, false));
  // Docker does not inherit host env. env -i also discards image defaults:
  // notably no GitHub tokens/command-file paths, NODE_OPTIONS, or npm auth.
  args.push('--entrypoint', '/usr/bin/env', imageId, '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp/home', 'TMPDIR=/tmp', 'CI=true',
    'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null',
    'NPM_CONFIG_CACHE=/tmp/npm-cache', 'NPM_CONFIG_USERCONFIG=/dev/null', 'NPM_CONFIG_UPDATE_NOTIFIER=false');
  if (install) args.push(executable, '-e', `
    const fs = require('node:fs'), { spawnSync } = require('node:child_process');
    const result = spawnSync('/usr/local/bin/npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
    const cache = 'node_modules/.vite-temp';
    if (fs.existsSync(cache)) {
      if (!fs.lstatSync(cache).isDirectory() || fs.lstatSync(cache).isSymbolicLink()) throw new Error('Unsafe Vite cache directory');
    } else fs.mkdirSync(cache);
  `);
  else if (phase === 'test-app') args.push(executable, '--test', ...context.tests[suites[0]].map(name => `server/tests/${name}`));
  else if (phase === 'tokens') args.push(executable, 'scripts/tokens.mjs', '--check');
  else if (phase === 'build-theme') args.push(executable, 'node_modules/vite/bin/vite.js', 'build');
  else if (phase === 'build-app') args.push(executable, 'node_modules/vite/bin/vite.js', 'build');
  else throw new Error(`Unknown phase: ${phase}`);
  return args;
}

function docker(args, { logs = true } = {}) {
  const container = args[0] === 'run' ? `release-desk-${randomUUID()}` : null;
  const command = container ? ['run', '--name', container, ...args.slice(1)] : args;
  const result = spawnSync('docker', command, { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  // Killing a timed-out Docker client alone does not stop its container.
  if (container && (result.error || result.status !== 0)) spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore', timeout: 15000 });
  if (logs) {
    // Candidate stdout cannot issue Actions workflow commands. The random
    // resume token is generated outside, and never supplied to, the container.
    const token = randomUUID();
    console.log(`::stop-commands::${token}`);
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    console.log(`\n::${token}::`);
  }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Isolated command failed (${result.status})`);
  return result.stdout.trim();
}

async function main() {
  assert.equal(process.platform, 'linux', 'The review sandbox requires a Linux Docker host');
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE, 'Run this helper in GitHub Actions');
  const scratch = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'release-desk-'));
  const trusted = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const candidate = path.join(process.env.GITHUB_WORKSPACE, 'candidate');
  const context = await stageReview(trusted, candidate, scratch);
  for (const folder of ['theme-dependencies', 'app-dependencies', 'theme-vite-cache', 'app-vite-cache', ...writablePaths.map(relative => `output/${relative}`)]) await fs.mkdir(path.join(scratch, folder), { recursive: true });
  await fs.cp(path.join(context.source, 'assets'), path.join(scratch, 'output/assets'), { recursive: true });
  docker(['pull', image]);
  // Resolve once: every phase uses the very same installed Node 22 image.
  context.imageId = docker(['image', 'inspect', '--format={{.Id}}', image], { logs: false });
  assert(/^sha256:[a-f0-9]{64}$/.test(context.imageId), 'Unexpected Docker image identity');
  context.user = `${process.getuid()}:${process.getgid()}`;
  for (const phase of ['install-theme', 'install-app', 'test-app', 'tokens', 'build-theme', 'build-app']) {
    console.log(`Running ${phase}`);
    docker(containerArguments(context, phase));
  }
  // The ephemeral runner discards scratch. Do not promote build outputs or
  // recursively inspect/delete candidate-writable paths from the host.
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
