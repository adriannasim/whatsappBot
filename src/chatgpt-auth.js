import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createOIDCVerifier } from './oidc.js';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);

function failure(code = 'AUTH_FAILED', retryable = false) {
  const messages = {
    AUTH_REQUIRED: 'Sign in with ChatGPT first: npm run login.',
    AUTH_DENIED: 'ChatGPT sign-in was cancelled or denied.',
    AUTH_FAILED: retryable
      ? 'ChatGPT authentication is temporarily unavailable. Please try again shortly.'
      : 'ChatGPT sign-in could not be completed. Please try signing in again.',
    SUBSCRIPTION_NOT_ENABLED: 'ChatGPT plan usage was not granted. Run npm run login -- --enable-plan to approve plan usage.',
  };
  return Object.assign(new Error(messages[code] || messages.AUTH_FAILED), { code, retryable });
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const secret = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64_000;
const clientIdValid = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{3,256}$/.test(value) && value !== 'dynamic_agent_client';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const equalSecret = (left, right) => typeof left === 'string' && typeof right === 'string'
  && Buffer.byteLength(left) === Buffer.byteLength(right)
  && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const hasPlan = (scopes) => scopes.includes('resource.invoke') && scopes.includes('chatgpt.tokens.use.direct');

function publicProfile(profile, state) {
  return {
    connected: Boolean(profile?.accessToken),
    planEnabled: Boolean(profile && hasPlan(profile.scopes || [])),
    email: profile?.email || null,
    name: profile?.name || null,
    clientId: profile?.clientId || null,
    hostId: state?.hostId || null,
    expiresAt: profile?.expiresAt || null,
    active: Boolean(profile && state.activeClientId === profile.clientId),
  };
}

function clearTokens(profile) {
  const { accessToken, refreshToken, idToken, scopes, expiresAt, earliestRefreshAt, ...registration } = profile;
  return registration;
}

function earliestRefresh(value) {
  if (value === undefined || value === null) return null;
  let parsed;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    parsed = value < 100_000_000_000 ? value * 1000 : value;
  } else if (typeof value === 'string' && value.length < 100) {
    parsed = /^\d+(\.\d+)?$/.test(value) ? earliestRefresh(Number(value)) : Date.parse(value);
  }
  if (!Number.isFinite(parsed) || parsed < 0) throw failure();
  return parsed;
}

/** Owns this bot's OAuth registrations; never reads browser or Codex credentials. */
export function createChatGPTAuth({
  authDir = './.chatgpt-auth', fetchImpl = globalThis.fetch, now = Date.now,
  loginTimeoutMs = 180_000, requestTimeoutMs = 15_000, lockTimeoutMs = 20_000,
  port = 0, createServerImpl = createServer, verifyIdToken,
} = {}) {
  const directory = path.resolve(authDir);
  const stateFile = path.join(directory, 'state.json');
  const lockDirectory = path.join(directory, '.credentials.lock');
  const verifyToken = verifyIdToken || createOIDCVerifier({ fetchImpl, now });
  let pendingRefresh;
  let pendingLogin = false;

  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
    await chmod(directory, 0o700);
  }

  async function loadState() {
    try {
      // O_NOFOLLOW prevents following a substituted credential-file symlink.
      const handle = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 2_000_000) throw failure();
        await handle.chmod(0o600);
        const state = JSON.parse(await handle.readFile('utf8'));
        if (state.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/.test(state.hostId)
          || !Array.isArray(state.profiles) || state.profiles.length > 100
          || state.profiles.some((profile) => !object(profile) || !clientIdValid(profile.clientId)
            || typeof profile.subject !== 'string' || !profile.subject)) throw failure();
        return state;
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure();
    }
  }

  async function saveState(state) {
    const temporary = path.join(directory, `state.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, stateFile); }
    finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async function withLock(action) {
    await ensureDirectory();
    const owner = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() };
    const ownerFile = path.join(lockDirectory, 'owner.json');
    const started = Date.now();
    while (true) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        try {
          const handle = await open(ownerFile, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(owner)); }
          finally { await handle.close(); }
        } catch (error) { await rm(lockDirectory, { recursive: true, force: true }); throw error; }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw failure();
        // Fail closed on stale locks: automatic recursive deletion can race a
        // new owner and allow two processes to rotate the same refresh token.
        let stale = false;
        let incomplete = false;
        try {
          const info = await lstat(lockDirectory);
          if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
          const staleOwner = JSON.parse(await readFile(ownerFile, 'utf8'));
          if (Number.isInteger(staleOwner.pid) && staleOwner.pid > 0) {
            try { process.kill(staleOwner.pid, 0); }
            catch (probeError) { stale = probeError.code === 'ESRCH'; }
          } else incomplete = true;
        } catch (readError) {
          if (readError.code === 'AUTH_FAILED') throw readError;
          // A competing process can be writing or releasing its lock.
          incomplete = true;
        }
        if (stale || (incomplete && Date.now() - started >= lockTimeoutMs)) {
          const error = failure();
          error.message = 'A previous ChatGPT credential operation left a lock. Stop all bot and sign-in processes, then remove the .credentials.lock directory inside your configured CHATGPT_AUTH_DIR and retry.';
          throw error;
        }
        if (Date.now() - started >= lockTimeoutMs) throw failure('AUTH_FAILED', true);
        await delay(50);
      }
    }
    try { return await action(); }
    finally {
      try {
        const current = JSON.parse(await readFile(ownerFile, 'utf8'));
        if (current.nonce === owner.nonce) await rm(lockDirectory, { recursive: true, force: true });
      } catch { /* Never mask the authentication result with lock cleanup. */ }
    }
  }

  async function initializedState() {
    let state = await loadState();
    if (!state) {
      state = { version: 1, hostId: `urn:uuid:${randomUUID()}`, activeClientId: null, profiles: [] };
      await saveState(state);
    }
    return state;
  }

  async function jsonResponse(response) {
    const text = await response.text();
    if (text.length > 256_000) throw failure();
    const value = JSON.parse(text);
    if (!object(value)) throw failure();
    return value;
  }

  async function postToken(fields) {
    try {
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(fields),
      });
      const body = await jsonResponse(response);
      if (!response.ok) {
        const error = failure('AUTH_FAILED', response.status === 429 || response.status >= 500);
        // Only known machine codes are retained; never provider text or tokens.
        if (typeof body.error === 'string' && /^[a-z_]{1,80}$/.test(body.error)) error.oauthCode = body.error;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.code === 'AUTH_FAILED') throw error;
      throw failure('AUTH_FAILED', true);
    }
  }

  async function validatedTokens(body, { clientId, nonce, previous, requireIdentity = false }) {
    if (!secret(body.access_token) || String(body.token_type).toLowerCase() !== 'bearer'
      || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 31_536_000
      || (body.scope !== undefined && typeof body.scope !== 'string')
      || (requireIdentity && typeof body.scope !== 'string')) throw failure();
    const scopes = body.scope === undefined ? previous?.scopes : body.scope.split(/\s+/).filter(Boolean);
    if (!Array.isArray(scopes)) throw failure();
    // The bot needs a renewable grant; a requested scope alone is not evidence of consent.
    if (requireIdentity && !secret(body.refresh_token)) throw failure();
    const refreshToken = body.refresh_token ?? previous?.refreshToken;
    if (!scopes.includes('offline_access') || !secret(refreshToken)) throw failure();
    let claims;
    if (body.id_token !== undefined) {
      claims = await verifyToken(body.id_token, { audience: clientId, nonce, expectedSubject: previous?.subject });
    } else if (requireIdentity) throw failure();
    if (!claims && !previous) throw failure();
    return {
      clientId,
      subject: claims?.sub || previous.subject,
      email: typeof claims?.email === 'string' ? claims.email : previous?.email || null,
      name: typeof claims?.name === 'string' ? claims.name : previous?.name || null,
      accessToken: body.access_token,
      refreshToken,
      idToken: body.id_token ?? previous?.idToken,
      scopes,
      expiresAt: now() + body.expires_in * 1000,
      earliestRefreshAt: earliestRefresh(body.earliest_refresh_at),
    };
  }

  async function status() {
    const state = await loadState();
    return publicProfile(state?.profiles.find((item) => item.clientId === state.activeClientId), state);
  }

  async function listAccounts() {
    const state = await loadState();
    return (state?.profiles || []).map((profile) => publicProfile(profile, state));
  }

  async function selectAccount(clientId) {
    return withLock(async () => {
      const state = await loadState();
      const profile = state?.profiles.find((item) => item.clientId === clientId);
      if (!profile) throw failure('AUTH_REQUIRED');
      state.activeClientId = clientId;
      await saveState(state);
      return publicProfile(profile, state);
    });
  }

  async function login({ onAuthorize, onStatus, newAccount = false, enablePlan = false, signal } = {}) {
    if (pendingLogin) throw failure('AUTH_FAILED', true);
    if (typeof onAuthorize !== 'function') throw new TypeError('An onAuthorize callback is required.');
    if (signal?.aborted) throw failure('AUTH_DENIED');
    pendingLogin = true;
    let server;
    let timer;
    let abortHandler;
    let serverErrorHandler;
    try {
      const snapshot = await withLock(initializedState);
      const selected = !newAccount && snapshot.profiles.find((item) => item.clientId === snapshot.activeClientId);
      const pending = snapshot.pendingRegistration;
      const savedClientId = selected?.clientId || (pending && pending.newAccount === Boolean(newAccount) ? pending.clientId : null);
      const stateSecret = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(64).toString('base64url');
      let callbackResolve;
      let callbackReject;
      let consumed = false;
      let redirectUri;
      const callback = new Promise((resolve, reject) => { callbackResolve = resolve; callbackReject = reject; });
      // The callback can reject while the terminal is still displaying the URL.
      callback.catch(() => {});
      const finish = (error, result) => {
        if (consumed) return;
        consumed = true;
        if (error) callbackReject(error); else callbackResolve(result);
      };
      server = createServerImpl((req, res) => {
        const reply = (statusCode, message) => {
          res.writeHead(statusCode, {
            'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            'Referrer-Policy': 'no-referrer', Connection: 'close',
          });
          res.end(message);
        };
        if (consumed) return reply(409, 'This sign-in attempt is already complete.');
        try {
          if (req.method !== 'GET' || typeof req.url !== 'string' || req.url.length > 16_000
            || req.headers.host !== new URL(redirectUri).host) return reply(400, 'Invalid callback.');
          const url = new URL(req.url, redirectUri);
          if (url.origin !== new URL(redirectUri).origin || url.pathname !== '/auth/callback'
            || ['state', 'code', 'client_id', 'error'].some((key) => url.searchParams.getAll(key).length > 1)
            || !equalSecret(url.searchParams.get('state'), stateSecret)) return reply(400, 'Invalid callback.');
          if (url.searchParams.has('error')) {
            if (url.searchParams.has('code')) return reply(400, 'Invalid callback.');
            reply(400, 'Sign-in was not completed. Return to the terminal.');
            finish(failure(url.searchParams.get('error') === 'access_denied' ? 'AUTH_DENIED' : 'AUTH_FAILED'));
            return;
          }
          const code = url.searchParams.get('code');
          const issuedClientId = url.searchParams.get('client_id') || savedClientId;
          if (!secret(code) || !clientIdValid(issuedClientId)
            || (savedClientId && issuedClientId !== savedClientId)) return reply(400, 'Invalid callback.');
          reply(200, 'Authorization received. You may close this window and return to the terminal.');
          finish(null, { code, clientId: issuedClientId });
        } catch { reply(400, 'Invalid callback.'); }
      });
      serverErrorHandler = () => finish(failure('AUTH_FAILED', true));
      server.on('error', serverErrorHandler);
      await new Promise((resolve, reject) => {
        const onError = () => reject(failure('AUTH_FAILED', true));
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
      });
      redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      timer = setTimeout(() => finish(failure('AUTH_DENIED')), loginTimeoutMs);
      abortHandler = () => finish(failure('AUTH_DENIED'));
      signal?.addEventListener('abort', abortHandler, { once: true });
      if (signal?.aborted) abortHandler();
      const authorize = new URL(AUTHORIZE_URL);
      const fields = {
        response_type: 'code', client_id: savedClientId || 'dynamic_agent_client',
        redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', state: stateSecret, nonce,
        ext_agent_host_id: snapshot.hostId,
      };
      if (!savedClientId) fields.agent_name_hint = 'WhatsApp Summary Bot';
      if (selected?.email) fields.login_hint = selected.email;
      if (enablePlan) fields.prompt = 'consent';
      // Do not put id_token_hint in a URL printed by a CLI: it is a credential.
      for (const [key, value] of Object.entries(fields)) authorize.searchParams.set(key, value);
      if (signal?.aborted) throw failure('AUTH_DENIED');
      Promise.resolve(onAuthorize(authorize.toString())).catch(() => finish(failure()));
      const received = await callback;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
      server = undefined;
      onStatus?.('Verifying ChatGPT authorization.');
      return await withLock(async () => {
        const state = await initializedState();
        const currentProfile = state.profiles.find((item) => item.clientId === received.clientId);
        let body;
        try {
          body = await postToken({
            grant_type: 'authorization_code', client_id: received.clientId, code: received.code,
            code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE,
          });
        } catch (error) {
          if (!savedClientId && error.oauthCode === 'invalid_grant') {
            state.pendingRegistration = { clientId: received.clientId, newAccount: Boolean(newAccount) };
            await saveState(state);
          }
          throw error;
        }
        const profile = await validatedTokens(body, {
          clientId: received.clientId, nonce, previous: currentProfile || selected || undefined, requireIdentity: true,
        });
        if (currentProfile && currentProfile.subject !== profile.subject) throw failure();
        state.profiles = state.profiles.filter((item) => item.clientId !== profile.clientId);
        state.profiles.push(profile);
        state.activeClientId = profile.clientId;
        if (state.pendingRegistration?.clientId === profile.clientId) delete state.pendingRegistration;
        await saveState(state);
        return publicProfile(profile, state);
      });
    } catch (error) {
      if (['AUTH_REQUIRED', 'AUTH_DENIED', 'AUTH_FAILED', 'SUBSCRIPTION_NOT_ENABLED'].includes(error.code)) throw error;
      throw failure();
    } finally {
      clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      if (server) {
        await new Promise((resolve) => {
          try { server.close(resolve); server.closeAllConnections?.(); } catch { resolve(); }
        });
      }
      pendingLogin = false;
    }
  }

  async function refreshAccessToken() {
    return withLock(async () => {
      const state = await loadState();
      const index = state?.profiles.findIndex((item) => item.clientId === state.activeClientId) ?? -1;
      const profile = index >= 0 ? state.profiles[index] : null;
      if (!profile?.accessToken || !profile.refreshToken) throw failure('AUTH_REQUIRED');
      if (!hasPlan(profile.scopes || [])) throw failure('SUBSCRIPTION_NOT_ENABLED');
      if (profile.expiresAt > now() + 60_000) return profile.accessToken;
      if (profile.earliestRefreshAt && now() < profile.earliestRefreshAt) {
        if (profile.expiresAt > now() + 5_000) return profile.accessToken;
        throw failure('AUTH_FAILED', true);
      }
      let body;
      try {
        body = await postToken({
          grant_type: 'refresh_token', client_id: profile.clientId,
          refresh_token: profile.refreshToken, resource: RESOURCE,
        });
      } catch (error) {
        if (TERMINAL_REFRESH_ERRORS.has(error.oauthCode)) {
          state.profiles[index] = clearTokens(profile);
          await saveState(state);
          throw failure('AUTH_REQUIRED');
        }
        throw error;
      }
      const refreshed = await validatedTokens(body, { clientId: profile.clientId, previous: profile });
      state.profiles[index] = refreshed;
      await saveState(state);
      if (!hasPlan(refreshed.scopes)) throw failure('SUBSCRIPTION_NOT_ENABLED');
      return refreshed.accessToken;
    });
  }

  async function getAccessToken() {
    if (!pendingRefresh) pendingRefresh = refreshAccessToken();
    const running = pendingRefresh;
    try { return await running; }
    finally { if (pendingRefresh === running) pendingRefresh = undefined; }
  }

  async function revoke(profile) {
    if (!profile?.refreshToken) return true;
    try {
      const response = await fetchImpl(DISCOVERY_URL, {
        headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) return false;
      const metadata = await jsonResponse(response);
      if (metadata.issuer !== ISSUER || typeof metadata.revocation_endpoint !== 'string') return false;
      const endpoint = new URL(metadata.revocation_endpoint);
      if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.hash) return false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await fetchImpl(endpoint.toString(), {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: profile.refreshToken, token_type_hint: 'refresh_token', client_id: profile.clientId,
            }),
          });
          await result.body?.cancel();
          if (result.ok) return true;
          if (result.status < 500 && result.status !== 429) return false;
        } catch { /* Retry a temporary revocation failure once. */ }
        if (attempt === 0) await delay(100);
      }
    } catch { /* Local logout must still complete when the issuer is unreachable. */ }
    return false;
  }

  async function logout() {
    return withLock(async () => {
      const state = await loadState();
      const index = state?.profiles.findIndex((item) => item.clientId === state.activeClientId) ?? -1;
      if (index < 0) return { remoteRevoked: true };
      const remoteRevoked = await revoke(state.profiles[index]);
      state.profiles[index] = clearTokens(state.profiles[index]);
      await saveState(state);
      return { remoteRevoked };
    });
  }

  return { login, getAccessToken, status, listAccounts, selectAccount, logout };
}
