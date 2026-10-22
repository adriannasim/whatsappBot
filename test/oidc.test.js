import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOIDCVerifier } from '../src/oidc.js';

const issuer = 'https://auth.openai.com';
const timestamp = 1_790_000_000;
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-key', use: 'sig', alg: 'RS256' };
const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-key', use: 'sig', alg: 'ES256' };
const claims = { iss: issuer, sub: 'subject-1', aud: 'oaiapp_test', nonce: 'nonce-1', iat: timestamp, exp: timestamp + 3600 };
const options = { audience: 'oaiapp_test', nonce: 'nonce-1', expectedSubject: 'subject-1' };
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

function token(payload = claims, header = { alg: 'RS256', kid: 'rsa-key' }, privateKey = rsa.privateKey) {
  const parts = [header, payload].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'));
  const key = header.alg === 'ES256' ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : privateKey;
  parts.push(sign('sha256', Buffer.from(parts.join('.')), key).toString('base64url'));
  return parts.join('.');
}

function harness({ jwks = [rsaJwk, ecJwk], metadata = {}, fetchOverride } = {}) {
  const calls = [];
  let time = timestamp * 1000;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (fetchOverride) return fetchOverride(url, init, calls);
    if (url.endsWith('openid-configuration')) return json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, ...metadata });
    assert.equal(url, `${issuer}/.well-known/jwks.json`);
    return json({ keys: jwks });
  };
  return { verify: createOIDCVerifier({ fetchImpl, now: () => time }), calls, setTime: (value) => { time = value; } };
}

test('verifies real RS256/ES256 signatures and caches trusted metadata', async () => {
  const h = harness();
  assert.equal((await h.verify(token(), options)).sub, 'subject-1');
  assert.equal((await h.verify(token(claims, { alg: 'ES256', kid: 'ec-key' }, ec.privateKey), options)).aud, 'oaiapp_test');
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.headers.Authorization, undefined);
  }
  h.setTime((timestamp + 301) * 1000);
  await h.verify(token(), options);
  assert.equal(h.calls.length, 4);
});

test('checks issuer, audience, authorized party, nonce, subject and required timestamps', async () => {
  const h = harness();
  const failures = [
    { iss: 'https://evil.example' }, { aud: 'another-client' }, { aud: ['oaiapp_test', 'other'] },
    { azp: 'other' }, { aud: ['oaiapp_test', 'other'], azp: 'other' }, { sub: '' }, { sub: null },
    { sub: 'different-user' }, { nonce: 'wrong' }, { nonce: undefined }, { iat: undefined },
    { exp: undefined }, { exp: timestamp - 6 }, { iat: timestamp + 6 }, { nbf: timestamp + 6 },
    { exp: timestamp }, { nbf: 'now' },
  ];
  for (const patch of failures) {
    await assert.rejects(h.verify(token({ ...claims, ...patch }), options), { code: 'AUTH_FAILED' });
  }
  assert.equal((await h.verify(token({ ...claims, aud: ['oaiapp_test', 'other'], azp: 'oaiapp_test' }), options)).sub, claims.sub);
  assert.equal((await h.verify(token({ ...claims, nonce: undefined }), { audience: 'oaiapp_test' })).sub, claims.sub);
});

test('rejects changed signatures and disallowed or ambiguous JOSE headers', async () => {
  const h = harness();
  const valid = token();
  const pieces = valid.split('.');
  const signature = Buffer.from(pieces[2], 'base64url');
  signature[0] ^= 1;
  pieces[2] = signature.toString('base64url');
  await assert.rejects(h.verify(pieces.join('.'), options), { code: 'AUTH_FAILED' });
  for (const patch of [{ alg: 'none' }, { alg: 'HS256' }, { crit: ['unknown'] }, { crit: [] }, { b64: false }, { kid: '' }]) {
    await assert.rejects(h.verify(token(claims, { alg: 'RS256', kid: 'rsa-key', ...patch }), options), { code: 'AUTH_FAILED' });
  }
  // Token-supplied key URLs are never followed.
  await h.verify(token(claims, { alg: 'RS256', kid: 'rsa-key', jku: 'https://evil.example/key', x5u: 'https://evil.example/cert' }), options);
  assert.ok(h.calls.every(({ url }) => url.startsWith(`${issuer}/`)));
});

test('rejects malformed token encodings and does not expose credentials in errors', async () => {
  const h = harness();
  for (const input of ['secret-user-token', `${token()}=`, token().replace('.', '..'), null, 'a'.repeat(32_001)]) {
    await assert.rejects(h.verify(input, options), (error) => error.code === 'AUTH_FAILED' && !error.message.includes('secret-user-token'));
  }
  assert.equal(h.calls.length, 0);
});

test('rejects untrusted discovery and incompatible signing keys', async () => {
  for (const metadata of [
    { issuer: 'https://evil.example' }, { jwks_uri: 'https://evil.example/key' },
    { jwks_uri: 'http://auth.openai.com/key' }, { jwks_uri: 'https://user:pass@auth.openai.com/key' },
    { id_token_signing_alg_values_supported: ['HS256'] },
  ]) await assert.rejects(harness({ metadata }).verify(token(), options), { code: 'AUTH_FAILED' });
  for (const jwks of [
    [{ ...rsaJwk, use: 'enc' }], [{ ...rsaJwk, key_ops: ['encrypt'] }], [{ ...rsaJwk, alg: 'ES256' }],
    [{ ...rsaJwk, kty: 'oct', k: 'c2VjcmV0' }], [rsaJwk, rsaJwk], [{ ...rsaJwk, d: 'secret' }],
  ]) await assert.rejects(harness({ jwks }).verify(token(), options), { code: 'AUTH_FAILED' });
});

test('refreshes unknown signing keys once and throttles repeated unknown IDs', async () => {
  let keysCalls = 0;
  const h = harness({ fetchOverride: async (url) => {
    if (url.endsWith('openid-configuration')) return json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` });
    keysCalls++;
    return json({ keys: keysCalls === 1 ? [ecJwk] : [rsaJwk, ecJwk] });
  } });
  await h.verify(token(), options);
  assert.equal(keysCalls, 2);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(h.verify(token(claims, { alg: 'RS256', kid: `unknown-${i}` }), options), { code: 'AUTH_FAILED' });
  }
  assert.equal(keysCalls, 2);
});

test('coalesces concurrent metadata fetches and sanitizes metadata failures', async () => {
  const h = harness();
  await Promise.all([h.verify(token(), options), h.verify(token(), options)]);
  assert.equal(h.calls.length, 2);
  const bad = harness({ fetchOverride: async () => new Response('private provider detail', { status: 503 }) });
  await assert.rejects(bad.verify(token(), options), (error) => error.code === 'AUTH_FAILED' && !error.message.includes('private'));
});

test('bounds metadata response size even without Content-Length', async () => {
  const h = harness({ fetchOverride: async () => new Response('x'.repeat(256_001), { status: 200 }) });
  await assert.rejects(h.verify(token(), options), { code: 'AUTH_FAILED' });
});
