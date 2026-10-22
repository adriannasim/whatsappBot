import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChatGPTAuth } from '../src/chatgpt-auth.js';

const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const REVOCATION = `${ISSUER}/oauth/revoke`;
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

function signedToken(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const bytes = `${header}.${payload}`;
  return `${bytes}.${sign('sha256', Buffer.from(bytes), privateKey).toString('base64url')}`;
}

async function fixture(t, options = {}) {
  const authDir = await mkdtemp(path.join(os.tmpdir(), 'whatsapp-auth-test-'));
  t.after(() => rm(authDir, { recursive: true, force: true }));
  const context = {
    authDir, time: Date.UTC(2026, 9, 21, 12), servers: [], tokenCalls: [], revokeCalls: [],
    tokenHandler: null, clientId: 'oaiapp_account_one', subject: 'user-one',
  };
  const state = () => readFile(path.join(authDir, 'state.json'), 'utf8').then(JSON.parse);
  context.state = state;
  context.idToken = (overrides = {}) => signedToken({
    iss: ISSUER, aud: context.clientId, sub: context.subject,
    iat: Math.floor(context.time / 1000), exp: Math.floor(context.time / 1000) + 3600,
    nonce: context.authorize?.searchParams.get('nonce'),
    email: `${context.subject}@example.test`, name: `Account ${context.subject}`,
    ...overrides,
  });
  context.tokens = (overrides = {}) => ({
    access_token: 'access-secret-one', refresh_token: 'refresh-secret-one',
    token_type: 'Bearer', expires_in: 3600, scope: SCOPE, id_token: context.idToken(), ...overrides,
  });
  context.fetchImpl = async (url, init = {}) => {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    if (url === DISCOVERY) return Response.json({
      issuer: ISSUER, jwks_uri: JWKS, revocation_endpoint: context.revocationEndpoint || REVOCATION,
      id_token_signing_alg_values_supported: ['RS256'],
    });
    if (url === JWKS) return Response.json({ keys: [jwk] });
    if (url === TOKEN_URL) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(init.body);
      context.tokenCalls.push(form);
      return context.tokenHandler ? context.tokenHandler(form) : Response.json(context.tokens());
    }
    if (url === REVOCATION) {
      context.revokeCalls.push(new URLSearchParams(init.body));
      if (context.failRevocation) throw new Error('private issuer response');
      return new Response(null, { status: 200 });
    }
    throw new Error('Unexpected network request');
  };
  context.createServerImpl = (handler) => {
    const server = new EventEmitter();
    server.listen = (port, host, callback) => {
      assert.equal(host, '127.0.0.1');
      server.port = port || 49152;
      queueMicrotask(callback);
    };
    server.address = () => ({ port: server.port });
    server.close = (callback) => { server.closed = true; callback?.(); };
    server.closeAllConnections = () => { server.connectionsClosed = true; };
    server.request = (url, { host = `127.0.0.1:${server.port}`, method = 'GET' } = {}) => {
      const response = {};
      handler({ url, method, headers: { host } }, {
        writeHead: (code, headers) => { response.code = code; response.headers = headers; },
        end: (body) => { response.body = body; },
      });
      return response;
    };
    context.servers.push(server);
    return server;
  };
  context.makeAuth = (extra = {}) => createChatGPTAuth({
    authDir, fetchImpl: context.fetchImpl, now: () => context.time,
    createServerImpl: context.createServerImpl, loginTimeoutMs: 2000,
    ...options, ...extra,
  });
  context.auth = context.makeAuth();
  context.receive = (overrides = {}) => {
    const params = new URLSearchParams({
      state: context.authorize.searchParams.get('state'), code: 'authorization-code-secret',
      client_id: context.clientId, ...overrides,
    });
    return context.servers.at(-1).request(`/auth/callback?${params}`);
  };
  context.login = (loginOptions = {}, callback) => context.auth.login({
    ...loginOptions,
    onAuthorize: async (url) => {
      context.authorize = new URL(url);
      if (callback) await callback(context); else assert.equal(context.receive().code, 200);
    },
  });
  return context;
}

test('initial OAuth uses loopback PKCE and issued client ID; credentials are private', async (t) => {
  const f = await fixture(t);
  const account = await f.login();
  const params = f.authorize.searchParams;
  assert.equal(f.authorize.origin + f.authorize.pathname, `${ISSUER}/api/accounts/authorize`);
  assert.equal(params.get('client_id'), 'dynamic_agent_client');
  assert.equal(params.get('agent_name_hint'), 'WhatsApp Summary Bot');
  assert.equal(params.get('scope'), SCOPE);
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('resource'), 'https://api.openai.com/v1');
  assert.match(params.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:49152/auth/callback');
  assert.equal(params.has('id_token_hint'), false);
  const exchange = f.tokenCalls[0];
  assert.equal(exchange.get('client_id'), f.clientId);
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('redirect_uri'), params.get('redirect_uri'));
  assert.equal(exchange.get('resource'), params.get('resource'));
  assert.equal(exchange.has('client_secret'), false);
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), params.get('code_challenge'));
  assert.equal(account.connected, true);
  assert.equal(account.planEnabled, true);
  assert.equal(account.email, 'user-one@example.test');
  assert.equal(JSON.stringify(account).includes('secret'), false);
  assert.equal((await stat(f.authDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.authDir, 'state.json'))).mode & 0o777, 0o600);
  assert.equal(f.servers[0].closed, true);
  assert.equal(await f.auth.getAccessToken(), 'access-secret-one');
  assert.equal(f.tokenCalls.length, 1);
});

test('bad callback state, duplicate parameters, paths, host, method and missing issued ID do not consume login', async (t) => {
  const f = await fixture(t);
  await f.login({}, ({ authorize, servers }) => {
    const server = servers.at(-1);
    const valid = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'code', client_id: f.clientId });
    assert.equal(f.receive({ state: 'attacker-state' }).code, 400);
    assert.equal(server.request(`/auth/callback?${valid}&state=duplicate`).code, 400);
    assert.equal(server.request(`/wrong?${valid}`).code, 400);
    assert.equal(server.request(`/auth/callback?${valid}`, { host: 'evil.example' }).code, 400);
    assert.equal(server.request(`/auth/callback?${valid}`, { method: 'POST' }).code, 400);
    valid.delete('client_id');
    assert.equal(server.request(`/auth/callback?${valid}`).code, 400);
    assert.equal(f.receive({ client_id: 'dynamic_agent_client' }).code, 400);
    assert.equal(f.receive().code, 200);
  });
  assert.equal(f.tokenCalls.length, 1);
});

test('denied, timed-out and cancelled login close the loopback listener without exchanging tokens', async (t) => {
  const f = await fixture(t, { loginTimeoutMs: 20 });
  await assert.rejects(f.login({}, ({ authorize, servers }) => {
    const query = new URLSearchParams({ state: authorize.searchParams.get('state'), error: 'access_denied' });
    assert.equal(servers.at(-1).request(`/auth/callback?${query}`).code, 400);
  }), { code: 'AUTH_DENIED' });
  await assert.rejects(f.login({}, () => {}), { code: 'AUTH_DENIED' });
  const controller = new AbortController();
  await assert.rejects(f.login({ signal: controller.signal }, () => controller.abort()), { code: 'AUTH_DENIED' });
  assert.equal(f.tokenCalls.length, 0);
  assert.equal(f.servers.every((server) => server.closed), true);
});

test('granted scopes determine plan enablement, and renewable scope must actually be granted', async (t) => {
  const f = await fixture(t);
  f.tokenHandler = () => Response.json(f.tokens({ scope: 'openid email profile offline_access' }));
  const account = await f.login();
  assert.equal(account.connected, true);
  assert.equal(account.planEnabled, false);
  await assert.rejects(f.auth.getAccessToken(), { code: 'SUBSCRIPTION_NOT_ENABLED' });
  const saved = await f.state();
  f.tokenHandler = () => Response.json(f.tokens({ scope: SCOPE.replace('offline_access ', '') }));
  await assert.rejects(f.login({ enablePlan: true }), { code: 'AUTH_FAILED' });
  assert.equal(f.authorize.searchParams.get('prompt'), 'consent');
  assert.deepEqual(await f.state(), saved);
  f.tokenHandler = () => Response.json(f.tokens({ scope: undefined }));
  // A returning authorization must report its actual grant, not silently inherit the old grant.
  await assert.rejects(f.login(), { code: 'AUTH_FAILED' });
  f.tokenHandler = () => Response.json(f.tokens({ refresh_token: undefined }));
  // A new consent grant must establish its own renewable authorization.
  await assert.rejects(f.login(), { code: 'AUTH_FAILED' });
  assert.deepEqual(await f.state(), saved);
});

test('returning sign-in reuses registration and accepts omitted callback client_id', async (t) => {
  const f = await fixture(t);
  await f.login();
  const hostId = (await f.auth.status()).hostId;
  await f.login({}, ({ authorize, servers }) => {
    assert.equal(authorize.searchParams.get('client_id'), f.clientId);
    assert.equal(authorize.searchParams.get('agent_name_hint'), null);
    assert.equal(authorize.searchParams.get('id_token_hint'), null);
    assert.equal(authorize.searchParams.get('ext_agent_host_id'), hostId);
    assert.equal(f.receive({ client_id: 'oaiapp_wrong_account' }).code, 400);
    const query = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'returning-code' });
    assert.equal(servers.at(-1).request(`/auth/callback?${query}`).code, 200);
  });
  assert.equal((await f.auth.listAccounts()).length, 1);
  assert.equal((await f.auth.status()).hostId, hostId);
});

test('invalid_grant on first exchange retains issued registration for the next sign-in attempt', async (t) => {
  const f = await fixture(t);
  f.tokenHandler = () => Response.json({ error: 'invalid_grant', error_description: 'secret response text' }, { status: 400 });
  await assert.rejects(f.login(), (error) => error.code === 'AUTH_FAILED' && !error.message.includes('secret'));
  assert.equal((await f.state()).pendingRegistration.clientId, f.clientId);
  assert.deepEqual(await f.auth.listAccounts(), []);
  f.tokenHandler = null;
  await f.login();
  assert.equal(f.authorize.searchParams.get('client_id'), f.clientId);
  assert.equal((await f.state()).pendingRegistration, undefined);
});

test('signed ID-token nonce/audience/subject failures never replace a previous account', async (t) => {
  const f = await fixture(t);
  await f.login();
  const before = await f.state();
  for (const changes of [{ nonce: 'wrong' }, { aud: 'oaiapp_other' }, { sub: 'different-user' }, { iss: 'https://evil.test' }]) {
    f.tokenHandler = () => Response.json(f.tokens({ id_token: f.idToken(changes) }));
    await assert.rejects(f.login(), { code: 'AUTH_FAILED' });
    assert.deepEqual(await f.state(), before);
  }
});

test('new accounts only become active after verification and may be selected explicitly', async (t) => {
  const f = await fixture(t);
  await f.login();
  const firstClientId = f.clientId;
  f.clientId = 'oaiapp_account_two';
  f.subject = 'user-two';
  f.tokenHandler = () => Response.json(f.tokens({ id_token: 'invalid-secret-token' }));
  await assert.rejects(f.login({ newAccount: true }), { code: 'AUTH_FAILED' });
  assert.equal((await f.auth.status()).clientId, firstClientId);
  f.tokenHandler = null;
  await f.login({ newAccount: true });
  assert.equal(f.authorize.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal((await f.auth.listAccounts()).length, 2);
  assert.equal((await f.auth.status()).clientId, f.clientId);
  await f.auth.selectAccount(firstClientId);
  assert.equal((await f.auth.status()).clientId, firstClientId);
  await assert.rejects(f.auth.selectAccount('unknown'), { code: 'AUTH_REQUIRED' });
});

test('refresh is single-flight across instances, rotates refresh tokens and preserves omitted scope', async (t) => {
  const f = await fixture(t);
  await f.login();
  f.time += 3_590_000;
  let refreshCount = 0;
  f.tokenHandler = async (form) => {
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('client_id'), f.clientId);
    assert.equal(form.get('resource'), 'https://api.openai.com/v1');
    assert.equal(form.has('scope'), false);
    assert.equal(form.get('refresh_token'), refreshCount === 0 ? 'refresh-secret-one' : 'refresh-secret-two');
    refreshCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return Response.json(f.tokens({
      access_token: `access-after-refresh-${refreshCount}`, refresh_token: 'refresh-secret-two',
      scope: undefined, id_token: f.idToken({ nonce: undefined }),
    }));
  };
  const secondInstance = f.makeAuth();
  const tokens = await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken(), secondInstance.getAccessToken()]);
  assert.deepEqual(tokens, ['access-after-refresh-1', 'access-after-refresh-1', 'access-after-refresh-1']);
  assert.equal(refreshCount, 1);
  const stored = (await f.state()).profiles[0];
  assert.equal(stored.refreshToken, 'refresh-secret-two');
  assert.ok(stored.scopes.includes('chatgpt.tokens.use.direct'));
  f.time += 3_590_000;
  assert.equal(await f.auth.getAccessToken(), 'access-after-refresh-2');
});

test('earliest_refresh_at is persisted and prevents premature refresh', async (t) => {
  const f = await fixture(t);
  f.tokenHandler = () => Response.json(f.tokens({ expires_in: 100, earliest_refresh_at: f.time / 1000 + 90 }));
  await f.login();
  f.time += 50_000;
  assert.equal(await f.auth.getAccessToken(), 'access-secret-one');
  assert.equal(f.tokenCalls.length, 1);
  f.time += 45_000;
  f.tokenHandler = () => Response.json(f.tokens({ access_token: 'later-access', earliest_refresh_at: f.time + 3_000_000 }));
  assert.equal(await f.auth.getAccessToken(), 'later-access');
  assert.equal((await f.state()).profiles[0].earliestRefreshAt, f.time + 3_000_000);
});

test('temporary refresh errors retain credentials, terminal refresh errors require login', async (t) => {
  const f = await fixture(t);
  await f.login();
  f.time += 3_600_000;
  const saved = await f.state();
  f.tokenHandler = () => Response.json({ error: 'server_error', error_description: 'private body' }, { status: 503 });
  await assert.rejects(f.auth.getAccessToken(), (error) => error.code === 'AUTH_FAILED' && error.retryable && !error.message.includes('private'));
  assert.deepEqual(await f.state(), saved);
  f.tokenHandler = () => Response.json({ error: 'refresh_token_reused' }, { status: 400 });
  await assert.rejects(f.auth.getAccessToken(), { code: 'AUTH_REQUIRED' });
  const remaining = (await f.state()).profiles[0];
  assert.equal(remaining.clientId, f.clientId);
  assert.equal(remaining.subject, f.subject);
  assert.equal(remaining.refreshToken, undefined);
  assert.equal(remaining.accessToken, undefined);
  assert.equal(remaining.idToken, undefined);
  assert.equal((await f.auth.status()).connected, false);
});

test('logout revokes only the active grant and retains installation and registration identifiers', async (t) => {
  const f = await fixture(t);
  await f.login();
  const hostId = (await f.auth.status()).hostId;
  assert.deepEqual(await f.auth.logout(), { remoteRevoked: true });
  assert.equal(f.revokeCalls.length, 1);
  assert.equal(f.revokeCalls[0].get('token'), 'refresh-secret-one');
  assert.equal(f.revokeCalls[0].get('token_type_hint'), 'refresh_token');
  assert.equal(f.revokeCalls[0].get('client_id'), f.clientId);
  const current = await f.auth.status();
  assert.equal(current.connected, false);
  assert.equal(current.clientId, f.clientId);
  assert.equal(current.hostId, hostId);
  assert.equal((await f.auth.listAccounts()).length, 1);
  await f.login();
  assert.equal(f.authorize.searchParams.get('client_id'), f.clientId);
});

test('failed or untrusted remote revocation still clears local credentials without sending secrets to another host', async (t) => {
  const f = await fixture(t);
  await f.login();
  f.failRevocation = true;
  assert.deepEqual(await f.auth.logout(), { remoteRevoked: false });
  assert.equal(f.revokeCalls.length, 2);
  assert.equal((await f.auth.status()).connected, false);
  await f.login();
  f.revocationEndpoint = 'https://evil.example/steal';
  assert.deepEqual(await f.auth.logout(), { remoteRevoked: false });
  assert.equal(f.revokeCalls.length, 2);
  assert.equal((await f.auth.status()).connected, false);
});
