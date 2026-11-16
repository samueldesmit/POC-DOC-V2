export class ApiError extends Error {
  constructor(message, code = 'REQUEST_FAILED', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const fixtureEnabled = import.meta.env.DEV && new URLSearchParams(window.location.search).get('fixture') === '1';

async function sessionToken() {
  if (typeof window.shopify?.idToken !== 'function') {
    throw new ApiError('Open Release Desk from the store’s Shopify admin to start an authenticated session.', 'SHOPIFY_SESSION_REQUIRED');
  }
  try {
    const token = await window.shopify.idToken();
    if (!token) throw new Error('No token returned');
    return token;
  } catch {
    throw new ApiError('The Shopify session could not be verified. Reopen the app from Shopify admin and try again.', 'SHOPIFY_SESSION_REQUIRED');
  }
}

export async function request(path, { method = 'GET', body, signal } = {}) {
  if (fixtureEnabled) {
    const { fixtureRequest } = await import('./fixture.js');
    return fixtureRequest(path, { method, body, signal });
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await sessionToken();
    const response = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    let result;
    try { result = await response.json(); }
    catch { throw new ApiError('The release service returned an unreadable response. Try again.', 'INVALID_RESPONSE', response.status); }
    if (response.status === 401 && attempt === 0) continue;
    if (!response.ok) throw new ApiError(result?.error?.message || 'The request could not be completed.', result?.error?.code, response.status);
    return result;
  }
  throw new ApiError('Your Shopify session expired. Reopen the app from Shopify admin.', 'SHOPIFY_SESSION_REQUIRED', 401);
}

export function externalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}
