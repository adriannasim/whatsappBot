import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeploymentConfig, checkDeployment, deploy } from '../scripts/pterodactyl-deploy.mjs';

const env = {
  PANEL_URL: 'https://panel.example.test',
  PTERODACTYL_SERVER_ID: 'a1b2c3d4',
  PTERODACTYL_API_KEY: 'ptlc_fixture_only',
  BOT_REVISION: 'a'.repeat(40),
};
const startup = { data: [
  { attributes: { env_variable: 'EXPECTED_REVISION', is_editable: true, server_value: '' } },
  { attributes: { env_variable: 'BOT_MODE', is_editable: true, server_value: 'run' } },
] };
const resource = (state, extra = {}) => ({ attributes: { current_state: state, is_suspended: false, ...extra } });

function fixture({ states = ['running', 'offline', 'running'], startupResult = startup, override } = {}) {
  const calls = [];
  const logs = [];
  const sleeps = [];
  let now = 0;
  let stateIndex = 0;
  return {
    calls, logs, sleeps,
    options: {
      now: () => now,
      sleepImpl: async ms => { sleeps.push(ms); now += ms; },
      log: value => logs.push(value),
      pollIntervalMs: 25,
      stopTimeoutMs: 100,
      startTimeoutMs: 100,
      fetchImpl: async (url, init) => {
        const route = new URL(url).pathname.replace('/api/client/servers/a1b2c3d4/', '');
        const call = { route, method: init.method, body: init.body && JSON.parse(init.body) };
        calls.push(call);
        assert.equal(init.headers.Authorization, `Bearer ${env.PTERODACTYL_API_KEY}`);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        const custom = await override?.(call, calls.length);
        if (custom !== undefined) return custom;
        if (route === 'startup') return Response.json(startupResult);
        if (route === 'resources') return Response.json(resource(states[Math.min(stateIndex++, states.length - 1)]));
        return new Response(null, { status: 204 });
      },
    },
  };
}

test('validates every deployment setting before any network or stop request', async () => {
  let calls = 0;
  for (const patch of [
    { PANEL_URL: undefined }, { PANEL_URL: 'http://panel.example.test' },
    { PANEL_URL: 'https://user:secret@panel.example.test' },
    { PANEL_URL: 'https://panel.example.test?token=secret' },
    { PANEL_URL: 'https://panel.example.test/#fragment' },
    { PTERODACTYL_SERVER_ID: '../another-server' }, { PTERODACTYL_SERVER_ID: '12' },
    { PTERODACTYL_API_KEY: undefined }, { PTERODACTYL_API_KEY: 'bad\nsecret' },
    { BOT_REVISION: 'main' }, { BOT_REVISION: 'A'.repeat(40) },
  ]) {
    await assert.rejects(deploy({ ...env, ...patch }, { fetchImpl: async () => { calls++; } }), { code: 'DEPLOY_CONFIG' });
  }
  assert.equal(calls, 0);
  const config = readDeploymentConfig({ ...env, PANEL_URL: 'https://panel.example.test/subpath/' });
  assert.equal(config.baseUrl, 'https://panel.example.test/subpath/api/client/servers/a1b2c3d4/');
});

test('read-only preflight checks startup variable and current state without mutations', async () => {
  const f = fixture();
  assert.deepEqual(await checkDeployment(env, f.options), { revision: env.BOT_REVISION });
  assert.deepEqual(f.calls.map(call => [call.method, call.route]), [['GET', 'startup'], ['GET', 'resources']]);
});

test('wrong egg, read-only revision, suspended and transitioning servers fail before stop', async () => {
  for (const startupResult of [{ data: [] }, { data: [{ attributes: { env_variable: 'EXPECTED_REVISION', is_editable: false } }] }]) {
    const f = fixture({ startupResult });
    await assert.rejects(deploy(env, f.options), { code: 'DEPLOY_CONFIG' });
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
  for (const state of ['starting', 'stopping']) {
    const f = fixture({ states: [state] });
    await assert.rejects(deploy(env, f.options), { code: 'DEPLOY_CONFIG' });
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
  const suspended = fixture({ override: call => call.route === 'resources' ? Response.json(resource('offline', { is_suspended: true })) : undefined });
  await assert.rejects(deploy(env, suspended.options), { code: 'DEPLOY_CONFIG' });
  assert.equal(suspended.calls.some(call => call.method !== 'GET'), false);
});

test('deployment waits out cached states and updates revision only after confirmed offline', async () => {
  const f = fixture({ states: ['running', 'running', 'stopping', 'offline', 'offline', 'starting', 'running'] });
  assert.deepEqual(await deploy(env, { ...f.options, stopTimeoutMs: 200, startTimeoutMs: 200 }), {
    revision: env.BOT_REVISION, state: 'running',
  });
  const mutations = f.calls.filter(call => call.method !== 'GET');
  assert.deepEqual(mutations, [
    { method: 'POST', route: 'power', body: { signal: 'stop' } },
    { method: 'PUT', route: 'startup/variable', body: { key: 'EXPECTED_REVISION', value: env.BOT_REVISION } },
    { method: 'POST', route: 'power', body: { signal: 'start' } },
  ]);
  assert.equal(f.sleeps.length, 4);
  assert.match(f.logs.at(-1), /process running/);
  assert.match(f.logs.at(-1), /not an end-to-end summary test/);
});

test('automatic deployment cannot interrupt setup modes or a missing/read-only BOT_MODE', async () => {
  const invalidModes = [
    undefined,
    { env_variable: 'BOT_MODE', is_editable: false, server_value: 'run' },
    ...['check', 'login', 'groups', '', 'RUN'].map(value => ({ env_variable: 'BOT_MODE', is_editable: true, server_value: value })),
  ];
  for (const mode of invalidModes) {
    const startupResult = { data: [startup.data[0], ...(mode ? [{ attributes: mode }] : [])] };
    const f = fixture({ startupResult });
    await assert.rejects(deploy(env, f.options), error => {
      assert.equal(error.code, 'DEPLOY_CONFIG');
      assert.match(error.message, /BOT_MODE/);
      return true;
    });
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
});

test('a stopped server can deploy without treating the stopped alias as an error', async () => {
  const f = fixture({ states: ['stopped', 'stopped', 'running'] });
  assert.equal((await deploy(env, f.options)).state, 'running');
});

test('a stop timeout prevents revision changes and start requests', async () => {
  const f = fixture({ states: ['running'] });
  await assert.rejects(deploy(env, f.options), { code: 'DEPLOY_TIMEOUT' });
  assert.deepEqual(f.calls.filter(call => call.method !== 'GET').map(call => call.body), [{ signal: 'stop' }]);
  assert.ok(f.sleeps.reduce((sum, ms) => sum + ms, 0) <= 100);
  assert.match(f.logs.at(-1), /did not complete/);
});

test('a start timeout never claims successful deployment', async () => {
  const f = fixture({ states: ['running', 'offline', 'starting'] });
  await assert.rejects(deploy(env, f.options), { code: 'DEPLOY_TIMEOUT' });
  assert.equal(f.logs.some(line => line.startsWith('Pterodactyl reports')), false);
});

test('failed or ambiguous power mutations are not retried and never reveal provider text or tokens', async () => {
  for (const networkFailure of [false, true]) {
    const f = fixture({ override: call => {
      if (call.route !== 'power') return;
      if (networkFailure) throw new Error(`private network detail ${env.PTERODACTYL_API_KEY}`);
      return Response.json({ error: `private body ${env.PTERODACTYL_API_KEY}` }, { status: 403 });
    } });
    await assert.rejects(deploy(env, f.options), error => {
      assert.equal(error.code, 'DEPLOY_REQUEST');
      assert.doesNotMatch(error.message, /private|ptlc_fixture_only/);
      return true;
    });
    assert.equal(f.calls.filter(call => call.route === 'power').length, 1);
    assert.doesNotMatch(f.logs.join('\n'), /private|ptlc_fixture_only/);
  }
});

test('failed revision update leaves server stopped and does not send start', async () => {
  const f = fixture({ override: call => call.route === 'startup/variable'
    ? Response.json({ error: 'private body' }, { status: 422 }) : undefined });
  await assert.rejects(deploy(env, f.options), { code: 'DEPLOY_REQUEST' });
  assert.equal(f.calls.some(call => call.body?.signal === 'start'), false);
  assert.match(f.logs.at(-1), /may be stopped/);
});

test('malformed API responses fail safely before changing server state', async () => {
  for (const response of [new Response('invalid JSON'), Response.json(resource('unknown'))]) {
    const f = fixture({ override: call => call.route === 'resources' ? response : undefined });
    await assert.rejects(deploy(env, f.options), { code: 'DEPLOY_RESPONSE' });
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
});
