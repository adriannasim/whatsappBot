import { pathToFileURL } from 'node:url';

const SERVER_ID = /^(?:[a-f0-9]{8}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i;
const REVISION = /^[a-f0-9]{40}$/;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function fail(message, code = 'DEPLOY_FAILED') {
  return Object.assign(new Error(message), { code });
}

/** Validate deployment inputs before sending credentials or changing server state. */
export function readDeploymentConfig(env = process.env) {
  let panel;
  try { panel = new URL(env.PANEL_URL); }
  catch { throw fail('Set PANEL_URL to the HTTPS address of your Pterodactyl panel.', 'DEPLOY_CONFIG'); }
  if (panel.protocol !== 'https:' || !panel.hostname || panel.username || panel.password || panel.search || panel.hash) {
    throw fail('PANEL_URL must use HTTPS without embedded credentials, a query, or a fragment.', 'DEPLOY_CONFIG');
  }
  const serverId = env.PTERODACTYL_SERVER_ID?.trim();
  if (!SERVER_ID.test(serverId || '')) {
    throw fail('Set PTERODACTYL_SERVER_ID to the server identifier from its panel URL, or its full UUID.', 'DEPLOY_CONFIG');
  }
  const apiKey = env.PTERODACTYL_API_KEY;
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(apiKey)) {
    throw fail('Set PTERODACTYL_API_KEY to a Client API key for the deployment subuser.', 'DEPLOY_CONFIG');
  }
  const revision = env.BOT_REVISION;
  if (typeof revision !== 'string' || !REVISION.test(revision)) {
    throw fail('BOT_REVISION must be the complete lowercase Git commit SHA that was tested and published.', 'DEPLOY_CONFIG');
  }
  panel.pathname = panel.pathname.replace(/\/+$/, '') + `/api/client/servers/${serverId}/`;
  return Object.freeze({ baseUrl: panel.toString(), apiKey, revision });
}

function createClient(config, fetchImpl, requestTimeoutMs) {
  return async function request(route, { method = 'GET', body, label = 'panel request', json = false } = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(route, config.baseUrl), {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'Application/vnd.pterodactyl.v1+json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw fail(`The ${label} could not reach Pterodactyl or timed out. No automatic retry was made.`, 'DEPLOY_REQUEST');
    }
    if (!response?.ok) {
      void response?.body?.cancel().catch(() => {});
      const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
      throw fail(`Pterodactyl rejected the ${label}${status}. Check the panel configuration and deployment permissions.`, 'DEPLOY_REQUEST');
    }
    if (!json) {
      void response.body?.cancel().catch(() => {});
      return;
    }
    try { return await response.json(); }
    catch { throw fail(`Pterodactyl returned an unreadable result for the ${label}.`, 'DEPLOY_RESPONSE'); }
  };
}

function readState(result) {
  const attributes = result?.attributes;
  if (attributes?.is_suspended === true) {
    throw fail('The Pterodactyl server is suspended. Resolve that before deploying.', 'DEPLOY_CONFIG');
  }
  const state = attributes?.current_state;
  if (!['offline', 'stopped', 'starting', 'running', 'stopping'].includes(state)) {
    throw fail('Pterodactyl did not report a recognized server state.', 'DEPLOY_RESPONSE');
  }
  return state;
}

async function preflight(request) {
  const startup = await request('startup', { json: true, label: 'startup preflight' });
  const variable = startup?.data?.find?.(item => item?.attributes?.env_variable === 'EXPECTED_REVISION')?.attributes;
  if (!variable || variable.is_editable !== true) {
    throw fail('The egg must expose an editable EXPECTED_REVISION startup variable before deploying.', 'DEPLOY_CONFIG');
  }
  const mode = startup?.data?.find?.(item => item?.attributes?.env_variable === 'BOT_MODE')?.attributes;
  if (!mode || mode.is_editable !== true || mode.server_value !== 'run') {
    throw fail('Complete setup and set the editable BOT_MODE startup variable to run before enabling deployment.', 'DEPLOY_CONFIG');
  }
  const state = readState(await request('resources', { json: true, label: 'server preflight' }));
  if (state === 'starting' || state === 'stopping') {
    throw fail('The server is already changing power state. Wait for it to finish, then rerun deployment.', 'DEPLOY_CONFIG');
  }
}

function dependencies(options) {
  const settings = {
    fetchImpl: globalThis.fetch,
    sleepImpl: sleep,
    now: Date.now,
    log: console.log,
    requestTimeoutMs: 15_000,
    pollIntervalMs: 5_000,
    stopTimeoutMs: 180_000,
    startTimeoutMs: 18 * 60_000,
    ...options,
  };
  for (const name of ['fetchImpl', 'sleepImpl', 'now', 'log']) {
    if (typeof settings[name] !== 'function') throw fail(`Invalid deployment option: ${name}.`, 'DEPLOY_CONFIG');
  }
  for (const name of ['requestTimeoutMs', 'pollIntervalMs', 'stopTimeoutMs', 'startTimeoutMs']) {
    if (!Number.isSafeInteger(settings[name]) || settings[name] < 1 || settings[name] > 2_147_483_647) {
      throw fail(`Invalid deployment option: ${name}.`, 'DEPLOY_CONFIG');
    }
  }
  return settings;
}

/** Read-only check suitable before publishing an image. */
export async function checkDeployment(env = process.env, options = {}) {
  const config = readDeploymentConfig(env);
  const settings = dependencies(options);
  await preflight(createClient(config, settings.fetchImpl, settings.requestTimeoutMs));
  return { revision: config.revision };
}

/** Deploy the published image without touching session files or printing secrets. */
export async function deploy(env = process.env, options = {}) {
  const config = readDeploymentConfig(env);
  const settings = dependencies(options);
  const request = createClient(config, settings.fetchImpl, settings.requestTimeoutMs);
  await preflight(request);

  async function waitForState(target, timeoutMs) {
    const deadline = settings.now() + timeoutMs;
    while (settings.now() < deadline) {
      const state = readState(await request('resources', { json: true, label: 'deployment status check' }));
      if (state === target || (target === 'offline' && state === 'stopped')) return;
      const remaining = deadline - settings.now();
      if (remaining <= 0) break;
      await settings.sleepImpl(Math.min(settings.pollIntervalMs, remaining));
    }
    throw fail(`The server did not reach ${target} before the deployment deadline. Inspect the Pterodactyl console; do not assume deployment succeeded.`, 'DEPLOY_TIMEOUT');
  }

  let stopRequested = false;
  try {
    settings.log('Stopping the bot before switching its expected image revision.');
    // Do not retry power mutations automatically if the response is ambiguous.
    stopRequested = true;
    await request('power', { method: 'POST', body: { signal: 'stop' }, label: 'stop request' });
    await waitForState('offline', settings.stopTimeoutMs);
    await request('startup/variable', {
      method: 'PUT', body: { key: 'EXPECTED_REVISION', value: config.revision }, label: 'revision update',
    });
    settings.log(`Starting the bot with expected revision ${config.revision}.`);
    await request('power', { method: 'POST', body: { signal: 'start' }, label: 'start request' });
    await waitForState('running', settings.startTimeoutMs);
    settings.log('Pterodactyl reports the bot process running. Confirm WhatsApp readiness in its console; this is not an end-to-end summary test.');
    return { revision: config.revision, state: 'running' };
  } catch (error) {
    if (stopRequested) {
      settings.log('Deployment did not complete. The bot may be stopped or starting; inspect its panel before retrying. No session files were changed.');
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const run = args.length === 0 ? deploy : args.length === 1 && args[0] === '--check' ? checkDeployment : null;
  if (!run) {
    console.error('Use pterodactyl-deploy.mjs with no arguments, or --check for a read-only preflight.');
    process.exitCode = 1;
  } else {
    run().then(() => {
      if (args.length) console.log('Deployment configuration and server preflight passed. No changes were made.');
    }).catch(error => {
      console.error(error?.code?.startsWith('DEPLOY_') ? error.message : 'Deployment failed. Inspect the server panel before retrying.');
      process.exitCode = 1;
    });
  }
}
