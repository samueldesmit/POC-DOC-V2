import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DeskError, ensure, isSha } from './errors.mjs';

// One preview target per deployment: the configured store, under the key 'store'.
export const PREVIEW_MARKET = 'store';
const DIRECTORIES = /^(assets|blocks|config|layout|locales|sections|snippets|templates)\//;
const MAX_THEME_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const protectedPreviewFile = file => /^config\/(?:markets|settings_data(?:\.context\.[^/]+)?)\.json$/.test(file) || /^(templates|locales|sections)\/.+\.json$/.test(file);
export function safeThemePath(file) {
  return typeof file === 'string' && DIRECTORIES.test(file) && file.length < 240 && !file.includes('\\') && !file.includes('\0') && !file.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) && /^[\w./-]+$/.test(file);
}
const gitBlobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function themeArray(result) {
  const themes = Array.isArray(result) ? result : result?.themes;
  ensure(Array.isArray(themes), 'PREVIEW_THEME_LIST', 'Shopify did not return the theme list.', 502);
  return themes;
}
export function previewThemeName(prNumber, market = PREVIEW_MARKET) {
  ensure(Number.isSafeInteger(prNumber) && prNumber > 0 && prNumber < 1e9 && market === PREVIEW_MARKET, 'PREVIEW_SCOPE', 'Invalid preview scope.', 400);
  return `Release Desk PR ${prNumber}`;
}

// Only the installed, pinned Shopify CLI runs here. PR packages, hooks and build
// scripts are never executed. Tokens are passed in a minimal environment, never
// argv, logs, generated Liquid, database records, or browser responses.
export function runPreviewCli(binary, args, options) {
  return new Promise((resolve, reject) => {
    const isScript = /\.[cm]?js$/.test(binary);
    const command = isScript ? process.execPath : binary;
    const child = spawn(command, isScript ? [binary, ...args] : args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, settled = false;
    const fail = (code, message) => { if (settled) return; settled = true; child.kill(); clearTimeout(timer); reject(new DeskError(code, message, 502)); };
    const timer = setTimeout(() => fail('PREVIEW_SHOPIFY_TIMEOUT', 'Shopify took too long to build this preview. Generate it again to retry.'), 6 * 60_000);
    timer.unref();
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) fail('PREVIEW_CLI_OUTPUT', 'Shopify returned too much preview output.'); else stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) fail('PREVIEW_CLI_OUTPUT', 'Shopify returned too much preview output.'); });
    child.on('error', () => fail('PREVIEW_CLI_UNAVAILABLE', 'The Shopify preview uploader is unavailable.'));
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) return reject(new DeskError('PREVIEW_SHOPIFY_ERROR', 'Shopify could not complete the preview upload. Check theme access, theme capacity and Liquid validation, then try again.', 502));
      try { const result = JSON.parse(stdout); ensure((!result?.status || result.status === 'success') && !result?.error && !result?.issues?.length, 'PREVIEW_SHOPIFY_ERROR', 'Shopify could not complete every file in the preview operation.', 502); resolve(result); }
      catch (error) { reject(error instanceof DeskError ? error : new DeskError('PREVIEW_CLI_OUTPUT', 'Shopify returned an unexpected preview response.', 502)); }
    });
  });
}

export class PreviewTransport {
  constructor({ config, github, runCli = runPreviewCli }) {
    this.config = config; this.github = github; this.runCli = runCli;
    this.root = path.resolve(config.dataDir, 'preview-work');
    this.cache = path.resolve(config.dataDir, 'preview-blobs');
  }
  configured() { return Boolean(this.config.previewThemeToken && this.config.shop); }
  async workspace(action) {
    await fs.mkdir(this.root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(this.root, 'job-'));
    try { return await action(directory); }
    finally {
      // Remove only the freshly allocated job directory under our owned root.
      const relative = path.relative(this.root, path.resolve(directory));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  cli(market, args, directory) {
    ensure(market === PREVIEW_MARKET && this.config.shop, 'PREVIEW_SCOPE', 'Unknown preview store.', 400);
    const token = this.config.previewThemeToken;
    ensure(token, 'PREVIEW_NOT_CONFIGURED', 'Store preview access has not been configured.', 503);
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { SHOPIFY_CLI_THEME_TOKEN: token, SHOPIFY_CLI_NO_ANALYTICS: '1', SHOPIFY_CLI_NO_NOTIFICATIONS: '1', CI: '1', NODE_ENV: 'production', SHOPIFY_CLI_RUN_FROM_SOURCE: '0' });
    return this.runCli(this.config.previewCliPath || 'shopify', ['theme', ...args, '--store', this.config.shop, '--no-input', '--json'], { cwd: directory, env });
  }
  async getCode(headSha) {
    ensure(isSha(headSha), 'INVALID_SHA', 'Preview requires an exact commit.', 400);
    const tree = await this.github.request('GET', this.github.route(`git/trees/${headSha}?recursive=1`));
    ensure(!tree.truncated && Array.isArray(tree.tree), 'PREVIEW_TREE_INCOMPLETE', 'The PR theme tree is incomplete.', 422);
    // Kickstarter keeps the theme at the repository root; only theme folders are previewed.
    const entries = tree.tree.filter(entry => DIRECTORIES.test(entry.path) && entry.type !== 'tree' && !entry.path.endsWith('/.gitkeep'));
    ensure(entries.length > 0 && entries.length <= 1000, 'PREVIEW_FILE_LIMIT', 'The PR theme exceeds the preview file limit.', 422);
    let total = 0;
    for (const entry of entries) {
      ensure(entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && safeThemePath(entry.path) && isSha(entry.sha), 'PREVIEW_UNSAFE_FILE', 'The PR contains an unsupported theme file or symbolic link.', 422);
      ensure(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_BLOB_BYTES, 'PREVIEW_FILE_LIMIT', 'A theme file exceeds the preview size limit.', 422);
      total += entry.size;
    }
    ensure(total <= MAX_THEME_BYTES, 'PREVIEW_SIZE_LIMIT', 'The theme exceeds the preview size limit.', 422);
    await fs.mkdir(this.cache, { recursive: true });
    const files = new Map(); let cursor = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (cursor < entries.length) {
        const entry = entries[cursor++], cachePath = path.join(this.cache, entry.sha);
        let bytes = await fs.readFile(cachePath).catch(() => null);
        if (!bytes || bytes.length !== entry.size || gitBlobSha(bytes) !== entry.sha) {
          const blob = await this.github.request('GET', this.github.route(`git/blobs/${entry.sha}`), undefined, { maxBytes: 12 * 1024 * 1024 });
          ensure(blob.sha === entry.sha && blob.encoding === 'base64' && typeof blob.content === 'string', 'PREVIEW_BLOB_INVALID', 'The PR theme content could not be verified.', 502);
          bytes = Buffer.from(blob.content, 'base64');
          ensure(bytes.length === entry.size && gitBlobSha(bytes) === entry.sha, 'PREVIEW_BLOB_INVALID', 'The PR theme content could not be verified.', 502);
          await fs.writeFile(cachePath, bytes, { mode: 0o600 });
        }
        files.set(entry.path, bytes);
      }
    }));
    return files;
  }
  async getStoreFiles(market) {
    return this.workspace(async directory => {
      const themes = themeArray(await this.cli(market, ['list'], directory));
      const live = themes.filter(theme => ['live', 'main'].includes(theme.role));
      ensure(live.length === 1 && /^\d+$/.test(String(live[0].id)), 'PREVIEW_LIVE_THEME', 'Could not identify the live store settings.', 502);
      const liveThemeId = String(live[0].id);
      // --force approves only this newly allocated local download directory.
      // It does not grant or request any live-theme write permission.
      const pulled = await this.cli(market, ['pull', '--force', '--theme', liveThemeId, '--path', directory, '--only', 'config/*.json', '--only', 'templates/**/*.json', '--only', 'templates/*.json', '--only', 'sections/*.json', '--only', 'locales/*.json'], directory);
      ensure(pulled?.status === 'success' && !pulled.issues?.length, 'PREVIEW_SETTINGS_INCOMPLETE', 'Shopify did not return a complete settings snapshot.', 502);
      const files = new Map(); let total = 0;
      const visit = async (relative = '') => {
        for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
          const file = relative ? `${relative}/${item.name}` : item.name;
          ensure(!item.isSymbolicLink(), 'PREVIEW_UNSAFE_FILE', 'Store settings contain an unsupported symbolic link.', 422);
          if (item.isDirectory()) { if (!item.name.startsWith('.')) await visit(file); }
          else if (protectedPreviewFile(file)) {
            ensure(safeThemePath(file), 'PREVIEW_UNSAFE_FILE', 'Store settings contain an unsupported path.', 422);
            const bytes = await fs.readFile(path.join(directory, file)); total += bytes.length;
            ensure(total <= MAX_THEME_BYTES, 'PREVIEW_SIZE_LIMIT', 'Store settings exceed the preview size limit.', 422);
            files.set(file, bytes);
          }
        }
      };
      await visit();
      ensure(files.has('config/settings_data.json') && files.has('templates/index.json'), 'PREVIEW_SETTINGS_MISSING', 'The complete store settings could not be loaded.', 502);
      return { files, liveThemeId };
    });
  }
  async isUnpublishedTheme({ market, themeId, prNumber }) {
    return this.workspace(async directory => {
      const themes = themeArray(await this.cli(market, ['list'], directory));
      const theme = themes.find(item => String(item.id) === String(themeId));
      return Boolean(theme && theme.role === 'unpublished' && !theme.processing && (!prNumber || theme.name === previewThemeName(prNumber, market)));
    });
  }
  async pushTheme({ market, prNumber, headSha, files, themeId }) {
    ensure(isSha(headSha) && files instanceof Map, 'PREVIEW_INPUT', 'Invalid preview build.', 400);
    const name = previewThemeName(prNumber, market);
    return this.workspace(async directory => {
      const themes = themeArray(await this.cli(market, ['list'], directory));
      // Recover a completed creation after a process restart, without making duplicates.
      const matches = themes.filter(theme => theme.name === name);
      ensure(matches.length <= 1, 'PREVIEW_THEME_AMBIGUOUS', 'Multiple matching preview themes exist. Rename the duplicate before trying again.', 409);
      const existing = (themeId ? themes.find(theme => String(theme.id) === String(themeId)) : null) || matches[0];
      if (existing) ensure(existing.role === 'unpublished' && existing.name === name && /^\d+$/.test(String(existing.id)), 'PREVIEW_LIVE_REFUSED', 'This theme is no longer an unpublished Release Desk preview. It will not be changed.', 409);
      ensure(existing || themes.filter(theme => theme.name?.startsWith('Release Desk PR ')).length < 10, 'PREVIEW_CAPACITY', 'This store already has ten PR preview themes. Remove unused preview themes before generating another.', 409);
      let total = 0;
      for (const [file, value] of files) {
        ensure(safeThemePath(file), 'PREVIEW_UNSAFE_FILE', 'The generated preview contains an unsupported path.', 422);
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); total += bytes.length;
        ensure(bytes.length <= MAX_BLOB_BYTES && total <= MAX_THEME_BYTES, 'PREVIEW_SIZE_LIMIT', 'The generated preview exceeds the size limit.', 422);
        const target = path.join(directory, file);
        await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
      }
      // Never --live, --publish or --allow-live. CLI checks the role again when
      // selecting the upload target. Do not manually publish an active preview.
      const selector = existing ? ['--theme', String(existing.id)] : ['--unpublished', '--theme', name];
      const result = await this.cli(market, ['push', ...selector, '--path', directory], directory);
      ensure(result?.status === 'success' && !result.issues?.length, 'PREVIEW_UPLOAD_INCOMPLETE', 'Shopify did not accept every preview file. No preview link is ready.', 502);
      const theme = result?.theme;
      ensure(theme && theme.role === 'unpublished' && /^\d+$/.test(String(theme.id)), 'PREVIEW_PUSH_RESULT', 'Shopify did not confirm an unpublished preview.', 502);
      const confirmed = themeArray(await this.cli(market, ['list'], directory)).find(item => String(item.id) === String(theme.id));
      ensure(confirmed?.role === 'unpublished' && confirmed.name === name && !confirmed.processing, 'PREVIEW_NOT_READY', 'Shopify is still processing the preview. Generate it again to check it.', 409);
      return { themeId: String(theme.id), previewUrl: `https://${this.config.shop}/?preview_theme_id=${theme.id}` };
    });
  }
}
