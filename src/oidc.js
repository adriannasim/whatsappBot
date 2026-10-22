import { createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';

const ISSUER = 'https://auth.openai.com';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CACHE_MS = 5 * 60_000;
const UNKNOWN_KEY_RETRY_MS = 30_000;
const CLOCK_SKEW_SECONDS = 5;
const MAX_DOCUMENT_BYTES = 256_000;
const MAX_TOKEN_LENGTH = 32_000;

function failure() {
  return Object.assign(new Error('ChatGPT sign-in could not be verified. Please sign in again.'), { code: 'AUTH_FAILED' });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readSegment(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw failure();
  const bytes = Buffer.from(segment, 'base64url');
  // Buffer's decoder is intentionally lenient; JWT segments must be canonical.
  if (bytes.toString('base64url') !== segment) throw failure();
  const value = JSON.parse(bytes.toString('utf8'));
  if (!object(value)) throw failure();
  return value;
}

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateClaims(claims, { audience, nonce, expectedSubject }, currentTime) {
  if (claims.iss !== ISSUER || typeof claims.sub !== 'string' || !claims.sub.trim()) throw failure();
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || audiences.length === 0
    || audiences.some((item) => typeof item !== 'string' || !item)
    || !audiences.includes(audience)) throw failure();
  if ((audiences.length > 1 && claims.azp !== audience)
    || (claims.azp !== undefined && claims.azp !== audience)) throw failure();

  const seconds = currentTime / 1000;
  if (!Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
    || claims.exp <= seconds - CLOCK_SKEW_SECONDS
    || claims.iat > seconds + CLOCK_SKEW_SECONDS || claims.exp <= claims.iat) throw failure();
  if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf)
    || claims.nbf > seconds + CLOCK_SKEW_SECONDS)) throw failure();
  if (nonce !== undefined && !equalSecret(claims.nonce, nonce)) throw failure();
  if (expectedSubject !== undefined && claims.sub !== expectedSubject) throw failure();
}

/** Validate OpenAI ID tokens against only the fixed production issuer's keys. */
export function createOIDCVerifier({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('Invalid OIDC verifier configuration');
  let discoveryCache;
  let discoveryPending;
  let keysCache;
  let keysPending;
  let unknownKeyRetryAt = -Infinity;

  async function fetchJson(url) {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw failure();
    const declaredBytes = Number(response.headers?.get('content-length') || 0);
    if (declaredBytes > MAX_DOCUMENT_BYTES) {
      await response.body?.cancel();
      throw failure();
    }
    // Bound streamed metadata independently of Content-Length.
    let text = '';
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_DOCUMENT_BYTES) {
            await reader.cancel();
            throw failure();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      text = await response.text();
      if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw failure();
    }
    const value = JSON.parse(text);
    if (!object(value)) throw failure();
    return value;
  }

  async function discovery() {
    if (discoveryCache && now() < discoveryCache.expiresAt) return discoveryCache.value;
    if (discoveryPending) return discoveryPending;
    discoveryPending = (async () => {
      const value = await fetchJson(DISCOVERY_URL);
      if (value.issuer !== ISSUER || typeof value.jwks_uri !== 'string') throw failure();
      const uri = new URL(value.jwks_uri);
      if (uri.origin !== ISSUER || uri.username || uri.password || uri.hash) throw failure();
      discoveryCache = { value, expiresAt: now() + CACHE_MS };
      return value;
    })();
    try { return await discoveryPending; }
    finally { discoveryPending = undefined; }
  }

  async function keys(metadata, force = false) {
    if (!force && keysCache && keysCache.uri === metadata.jwks_uri && now() < keysCache.expiresAt) {
      return keysCache.value;
    }
    if (keysPending) return keysPending;
    keysPending = (async () => {
      const value = await fetchJson(metadata.jwks_uri);
      if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 100
        || value.keys.some((key) => !object(key))) throw failure();
      keysCache = { value: value.keys, uri: metadata.jwks_uri, expiresAt: now() + CACHE_MS };
      return value.keys;
    })();
    try { return await keysPending; }
    finally { keysPending = undefined; }
  }

  return async function verifyIdToken(idToken, { audience, nonce, expectedSubject } = {}) {
    try {
      if (typeof audience !== 'string' || !audience
        || (nonce !== undefined && (typeof nonce !== 'string' || !nonce))
        || (expectedSubject !== undefined && (typeof expectedSubject !== 'string' || !expectedSubject))
        || typeof idToken !== 'string' || idToken.length > MAX_TOKEN_LENGTH) throw failure();
      const parts = idToken.split('.');
      if (parts.length !== 3) throw failure();
      const header = readSegment(parts[0]);
      const claims = readSegment(parts[1]);
      if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string' || !header.kid
        || header.crit !== undefined || (header.b64 !== undefined && header.b64 !== true)) throw failure();
      if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw failure();
      const signature = Buffer.from(parts[2], 'base64url');
      if (signature.toString('base64url') !== parts[2]) throw failure();

      const metadata = await discovery();
      if (metadata.id_token_signing_alg_values_supported !== undefined
        && (!Array.isArray(metadata.id_token_signing_alg_values_supported)
          || !metadata.id_token_signing_alg_values_supported.includes(header.alg))) throw failure();
      let availableKeys = await keys(metadata);
      let matches = availableKeys.filter((key) => key.kid === header.kid);
      if (matches.length === 0 && now() >= unknownKeyRetryAt) {
        unknownKeyRetryAt = now() + UNKNOWN_KEY_RETRY_MS;
        availableKeys = await keys(metadata, true);
        matches = availableKeys.filter((key) => key.kid === header.kid);
      }
      if (matches.length !== 1) throw failure();
      const jwk = matches[0];
      if ((jwk.alg !== undefined && jwk.alg !== header.alg)
        || (jwk.use !== undefined && jwk.use !== 'sig')
        || (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))
        || jwk.d !== undefined) throw failure();
      if (header.alg === 'RS256' && jwk.kty !== 'RSA') throw failure();
      if (header.alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || signature.length !== 64)) throw failure();
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      if (header.alg === 'RS256' && key.asymmetricKeyDetails?.modulusLength < 2048) throw failure();
      const keyOptions = header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key;
      if (!verifySignature('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), keyOptions, signature)) throw failure();
      validateClaims(claims, { audience, nonce, expectedSubject }, now());
      return claims;
    } catch {
      // Keep provider response bodies, credentials and token claims out of logs.
      throw failure();
    }
  };
}
