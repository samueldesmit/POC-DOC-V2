import { DeskError } from './errors.mjs';

// The store's own look for the merchant screen, read per store at runtime:
// colours and logo from the live theme's settings (the repository), the logo's
// file URL and the shop name from the Shopify Admin API. Nothing is configured
// per client; every value has a neutral fallback.
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const TOKEN_TTL_MS = 50 * 60_000, BRAND_TTL_MS = 10 * 60_000;

export function parseSettings(raw) {
  try {
    const data = JSON.parse(String(raw).replace(/^\uFEFF/, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    const current = typeof data.current === 'string' ? data.presets?.[data.current] : data.current;
    return current && typeof current === 'object' ? current : {};
  } catch { return {}; }
}
function rgb(hex) {
  let h = hex.slice(1); if (h.length === 3) h = [...h].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
}
function hsl(hex) {
  const [r, g, b] = rgb(hex), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { s, l };
}
// The most "brand-like" colour in the theme: saturated, not too light or dark.
// Status colours (info, success, warning, error, sale) and greys are not the brand.
const NOT_BRAND = /info|success|warning|error|sale|disabled|shadow|border|svg|arrow|overlay|gradient/i;
const BUTTONISH = /button|primary|secondary|accent|brand/i;
export function pickAccent(settings) {
  const entries = [];
  const visit = (value, key = '') => {
    if (typeof value === 'string' && HEX.test(value)) { if (!NOT_BRAND.test(key)) entries.push({ key, hex: value.toLowerCase() }); }
    else if (value && typeof value === 'object') for (const [child, inner] of Object.entries(value)) visit(inner, child);
  };
  visit(settings.color_schemes || {});
  for (const [key, value] of Object.entries(settings)) if (/colou?r/i.test(key) && key !== 'color_schemes') visit(value, key);
  const scored = [...new Map(entries.map(entry => [entry.hex, entry])).values()].map(entry => { const { s, l } = hsl(entry.hex); return { ...entry, score: s * (1 - Math.abs(l - 0.45) * 1.6) }; }).filter(item => item.score > 0.2).sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].hex;
  // A black-and-white theme: use its button colour (the darkest one), so the app still matches.
  const buttons = entries.filter(entry => BUTTONISH.test(entry.key)).map(entry => ({ ...entry, l: hsl(entry.hex).l })).filter(entry => entry.l < 0.85).sort((a, b) => a.l - b.l);
  return buttons[0]?.hex || null;
}
export function readableOn(hex) {
  const [r, g, b] = rgb(hex).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#1a1a1a' : '#ffffff';
}
export function logoFilename(settings) {
  for (const key of ['desktop_logo', 'logo', 'mobile_logo', 'favicon']) {
    const match = typeof settings[key] === 'string' && settings[key].match(/^shopify:\/\/shop_images\/([^/?#]{1,200})$/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

export class Brand {
  constructor({ config, github, fetchImpl = fetch }) { Object.assign(this, { config, github, fetch: fetchImpl }); this.token = null; this.cache = null; }
  // Exchange the merchant's session token for an offline Admin API token (token exchange).
  async adminToken(sessionToken) {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const response = await this.fetch(`https://${this.config.shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error',
      body: JSON.stringify({ client_id: this.config.apiKey, client_secret: this.config.apiSecret, grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: sessionToken, subject_token_type: 'urn:ietf:params:oauth:token-type:id_token', requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token' }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') throw new DeskError('ADMIN_TOKEN', 'Shopify did not grant store access.', 502);
    this.token = { value: body.access_token, expires: Date.now() + TOKEN_TTL_MS };
    return this.token.value;
  }
  async admin(sessionToken, query, variables = {}) {
    const response = await this.fetch(`https://${this.config.shop}/admin/api/2026-10/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await this.adminToken(sessionToken) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new DeskError('ADMIN_API', 'The Shopify Admin API did not respond.', 502);
    return body.data || {};
  }
  async get(sessionToken) {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    const fallback = { name: this.config.shop.replace(/\.myshopify\.com$/, ''), accent: null, accentText: null, logoUrl: null };
    let settings = {};
    try { settings = parseSettings((await this.github.readFile('config/settings_data.json', this.config.liveBranch)).content.toString('utf8')); } catch { /* theme without settings: neutral look */ }
    const accent = pickAccent(settings), filename = logoFilename(settings);
    let name = fallback.name, logoUrl = null;
    // Two small queries: the shop name needs no scope, the logo file needs read_files.
    try { const data = await this.admin(sessionToken, '{ shop { name } }'); if (typeof data.shop?.name === 'string') name = data.shop.name; }
    catch { /* no Admin access yet: name from the domain */ }
    if (filename) {
      try {
        const data = await this.admin(sessionToken, `query Logo($q: String!) { files(first: 1, query: $q) { nodes { ... on MediaImage { image { url } } ... on GenericFile { url } } } }`, { q: `filename:"${filename.replace(/["\\]/g, '')}"` });
        const file = data.files?.nodes?.[0], url = file?.image?.url || file?.url;
        if (typeof url === 'string' && url.startsWith('https://')) logoUrl = url;
      } catch { /* without read_files: initials instead of a logo */ }
    }
    const value = { name, accent, accentText: accent ? readableOn(accent) : null, logoUrl };
    this.cache = { value, expires: Date.now() + BRAND_TTL_MS };
    return value;
  }
}
