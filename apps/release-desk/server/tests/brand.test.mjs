import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings, pickAccent, readableOn, logoFilename, Brand } from '../brand.mjs';

const settings = { desktop_logo: 'shopify://shop_images/my%20logo.svg', color_schemes: { a: { settings: { background: '#ffffff', text: '#000000', button: '#e4572e' } }, b: { settings: { background: '#f5f5f5', accent: '#2b6cb0' } } } };

test('theme settings parse with Shopify comment headers and presets', () => {
  assert.deepEqual(parseSettings('/* auto-generated */ {"current": {"a": 1}}'), { a: 1 });
  assert.deepEqual(parseSettings('{"current": "Default", "presets": {"Default": {"b": 2}}}'), { b: 2 });
  assert.deepEqual(parseSettings('not json'), {});
});

test('the accent is the most brand-like colour, never white, black or grey', () => {
  assert.equal(pickAccent(settings), '#e4572e');
  assert.equal(pickAccent({ color_schemes: { a: { settings: { background: '#ffffff', text: '#000000', border: '#cccccc' } } } }), null);
  // Kickstarter-style: black and white buttons with coloured status colours.
  assert.equal(pickAccent({ color_schemes: { a: { settings: { background: '#ffffff', primary_background: '#ffffff', secondary_background: '#000000', warning_color: '#ffb538', error_color: '#ff674d', info_color: '#3fa7d6' } } } }), '#000000');
});

test('text on the accent stays readable', () => {
  assert.equal(readableOn('#e4572e'), '#ffffff');
  assert.equal(readableOn('#ffe066'), '#1a1a1a');
});

test('the logo file comes from the theme logo setting', () => {
  assert.equal(logoFilename(settings), 'my logo.svg');
  assert.equal(logoFilename({ logo: 'https://evil.example/x.png' }), null);
});

test('brand falls back to the shop handle and no logo without Admin access', async () => {
  const brand = new Brand({ config: { shop: 'example-store.myshopify.com', liveBranch: 'main', apiKey: 'k', apiSecret: 's' }, github: { readFile: async () => ({ content: Buffer.from(JSON.stringify({ current: settings })) }) }, fetchImpl: async () => new Response('{}', { status: 401 }) });
  assert.deepEqual(await brand.get('session'), { name: 'example-store', accent: '#e4572e', accentText: '#ffffff', logoUrl: null });
});

test('with Admin access the shop name and logo URL come from Shopify', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/admin/oauth/access_token')) { assert.equal(JSON.parse(options.body).subject_token, 'session'); return new Response(JSON.stringify({ access_token: 'offline' }), { status: 200 }); }
    assert.equal(options.headers['X-Shopify-Access-Token'], 'offline');
    const body = JSON.parse(options.body);
    if (body.query.includes('shop')) return new Response(JSON.stringify({ data: { shop: { name: 'Example Store' } } }), { status: 200 });
    assert.match(body.variables.q, /filename:"my logo.svg"/);
    return new Response(JSON.stringify({ data: { files: { nodes: [{ url: 'https://cdn.shopify.com/s/files/logo.svg' }] } } }), { status: 200 });
  };
  const brand = new Brand({ config: { shop: 'example-store.myshopify.com', liveBranch: 'main', apiKey: 'k', apiSecret: 's' }, github: { readFile: async () => ({ content: Buffer.from(JSON.stringify({ current: settings })) }) }, fetchImpl });
  const value = await brand.get('session');
  assert.equal(value.name, 'Example Store'); assert.equal(value.logoUrl, 'https://cdn.shopify.com/s/files/logo.svg');
  await brand.get('session');
  assert.equal(calls.length, 3, 'brand and token are cached');
});
