import { jwtVerify } from 'jose';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeskError, ensure } from './errors.mjs';

// Shopify's own decoder permits 10 seconds of exp/nbf clock tolerance:
// https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/lib/session/decode-session-token.ts
// Use a narrower fixed window for cached App Bridge tokens near a second boundary.
export const SESSION_CLOCK_TOLERANCE_SECONDS = 5;
const diagnosticCodes = new Set(['ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_INVALID', 'ERR_JWS_INVALID', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_NOT_SUPPORTED']);
const diagnosticClaims = new Set(['exp', 'nbf', 'aud', 'iss', 'dest', 'sub', 'iat']);
const logRejection = diagnostic => console.warn(JSON.stringify(diagnostic));

export async function authenticate(header, config, { onReject = logRejection } = {}) {
  ensure(config.apiKey && config.apiSecret, 'AUTH_UNCONFIGURED', 'Shopify authentication is not configured.', 503);
  ensure(typeof header === 'string' && /^Bearer [^\s]+$/.test(header) && header.length < 8192, 'UNAUTHENTICATED', 'A Shopify session token is required.', 401);
  try {
    const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(config.apiSecret), {
      algorithms: ['HS256'], audience: config.apiKey, issuer: `https://${config.shop}/admin`,
      requiredClaims: ['exp', 'nbf', 'aud', 'iss', 'dest', 'sub'], clockTolerance: SESSION_CLOCK_TOLERANCE_SECONDS,
    });
    // Exact values reject ports, credentials, suffix hosts, HTTP and arbitrary paths.
    ensure(payload.dest === `https://${config.shop}`, 'INVALID_SESSION', 'Invalid Shopify destination.', 401);
    ensure(typeof payload.sub === 'string' && /^\d+$/.test(payload.sub), 'INVALID_SESSION', 'Invalid Shopify user.', 401);
    return { id: payload.sub, shop: config.shop, canMutate: config.reviewers.size === 0 || config.reviewers.has(payload.sub) };
  } catch (error) {
    if (error instanceof DeskError) throw error;
    // Deliberately omit messages, tokens, payloads, user IDs and all claim values.
    // A logging failure must never convert rejection into acceptance or mask it.
    try { onReject({ event: 'shopify.session_rejected', code: diagnosticCodes.has(error.code) ? error.code : 'AUTH_VERIFICATION_FAILED', claim: diagnosticClaims.has(error.claim) ? error.claim : null }); } catch {}
    throw new DeskError('INVALID_SESSION', 'The Shopify session is invalid or expired.', 401);
  }
}
export function verifyWebhook(raw, signature, secret) {
  if (!secret || !Buffer.isBuffer(raw) || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const supplied = Buffer.from(signature.slice(7), 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
