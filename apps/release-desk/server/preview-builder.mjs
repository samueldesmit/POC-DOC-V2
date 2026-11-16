import { createHash } from 'node:crypto';
import { DeskError } from './errors.mjs';

// Root-level Shopify theme (kickstarter layout): the PR's code, with the live
// store's own content laid over it. Templates, section groups, locales and
// settings that already exist live keep their live values, so the preview shows
// the real pages. Content files that exist only in the PR (a new template) come
// from the PR.
const THEME_PATH = /^(assets|blocks|config|layout|locales|sections|snippets|templates)\/(?:[A-Za-z0-9_-][A-Za-z0-9_.@-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.@-]*$/;
export const isPreviewProtectedFile = file => /^config\/(?:markets|settings_data(?:\.context\.[^/]+)?)\.json$/.test(file) || /^(templates|locales|sections)\/.+\.json$/.test(file);
const BUILD_INPUT = /^(?:src\/|(?:vite|tailwind|postcss)\.config\.|(?:design-tokens|package(?:-lock)?|tsconfig)\.json$|scripts\/)/;
const COMPILED = /^assets\/(?:index\.css|main\.js|global\.js)$/;
const fail = message => { throw new DeskError('PREVIEW_BUILD_INVALID', message, 422); };

function checkedFiles(input, label) {
  if (!(input instanceof Map)) fail(`${label} must be a Map of theme files.`);
  const result = new Map();
  for (const [file, value] of input) {
    if (typeof file !== 'string' || /\/\.gitkeep$/.test(file)) continue;
    if (!THEME_PATH.test(file) || file.split('/').some(part => part === '.' || part === '..')) fail(`Unsafe theme path: ${file}`);
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) fail(`${label} contains non-file content: ${file}`);
    result.set(file, Buffer.isBuffer(value) ? Buffer.from(value) : value);
  }
  return result;
}
function settingsDigest(files) {
  const digest = createHash('sha256');
  for (const [file, value] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = Buffer.from(value);
    digest.update(`${file.length}:${file}:${bytes.length}:`); digest.update(bytes);
  }
  return digest.digest('hex');
}
// Storefront pages worth opening for this change. Only paths that exist without
// a resource handle; product and collection pages need a real handle from the store.
function targetsFor(changed) {
  const targets = [{ label: 'Homepage', path: '/' }];
  const names = changed.map(file => file.filename);
  if (names.some(name => /^templates\/(?:collection|list-collections)[.\w-]*\.json$/.test(name))) targets.push({ label: 'All products', path: '/collections/all' });
  if (names.some(name => /^templates\/search[.\w-]*\.json$/.test(name))) targets.push({ label: 'Search', path: '/search?q=a' });
  if (names.some(name => /^templates\/cart[.\w-]*\.json$/.test(name) || /^sections\/cart/.test(name))) targets.push({ label: 'Cart', path: '/cart' });
  if (names.some(name => /^templates\/404[.\w-]*\.json$/.test(name))) targets.push({ label: '404 page', path: '/pages/release-desk-preview-404' });
  return targets;
}

export function buildPreviewTheme({ codeFiles, storeFiles, changedFiles = [] }) {
  const code = checkedFiles(codeFiles, 'The PR theme');
  const store = checkedFiles(storeFiles, 'The store settings');
  if (!code.has('layout/theme.liquid')) fail('The PR does not contain a complete theme (layout/theme.liquid is missing).');
  const files = new Map(code);
  for (const [file, value] of store) if (isPreviewProtectedFile(file)) files.set(file, value);
  const notes = [];
  const names = changedFiles.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  if (names.some(name => BUILD_INPUT.test(name)) && !names.some(name => COMPILED.test(name))) notes.push('This PR changes source files (src/, Tailwind or build config) but not the compiled assets yet. The build workflow commits them to the PR; generate the preview again after it has run.');
  if (names.some(name => isPreviewProtectedFile(name) && store.has(name))) notes.push('Content files that already exist on the live store (templates, section groups, settings) show the live content in this preview, not the PR version.');
  return { files, targets: targetsFor(changedFiles), settingsDigest: settingsDigest(store), notes };
}
