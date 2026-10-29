import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppConnection } from '../src/connection.js';

const reasons = {
  loggedOut: 401, badSession: 500, connectionReplaced: 440, forbidden: 403,
  multideviceMismatch: 411, restartRequired: 515,
};
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

async function fixture(t, options = {}) {
  const authDir = await mkdtemp(path.join(os.tmpdir(), 'baileys-connection-test-'));
  t.after(() => rm(authDir, { force: true, recursive: true }));
  const sockets = [];
  const configs = [];
  const timerJobs = new Map();
  const received = [];
  const opened = [];
  const qrs = [];
  const errors = [];
  const logs = [];
  let disconnects = 0;
  let authLoads = 0;
  let saves = 0;
  let serial = 0;
  const state = { creds: { me: { id: '123:5@s.whatsapp.net', lid: '987:2@lid' } }, keys: {} };
  const fake = {
    reasons,
    onDemandType: 6,
    logger: { level: 'silent' },
    useAuthState: async directory => {
      assert.equal(directory, authDir);
      authLoads++;
      return { state, saveCreds: options.saveCreds || (async () => { saves++; }) };
    },
    cacheKeys: (keys, logger) => {
      assert.equal(keys, state.keys);
      assert.equal(logger.level, 'silent');
      return keys;
    },
    makeSocket: config => {
      configs.push(config);
      const socket = {
        ev: new EventEmitter(), user: { id: '123:9@s.whatsapp.net', lid: '987:3@lid' },
        ended: 0, loggedOut: 0,
        end() { this.ended++; },
        logout() { this.loggedOut++; },
      };
      sockets.push(socket);
      return socket;
    },
  };
  const connection = createWhatsAppConnection({
    authDir,
    onMessages: values => received.push(values),
    onOpen: socket => opened.push(socket),
    onQR: qr => qrs.push(qr),
    onDisconnect: () => { disconnects++; },
    onFatal: code => errors.push(code),
    log: message => logs.push(message),
    loadDependencies: async () => fake,
    setTimeoutImpl: (callback, delay) => { timerJobs.set(++serial, { callback, delay }); return serial; },
    clearTimeoutImpl: id => timerJobs.delete(id),
    ...options,
  });
  t.after(() => connection.stop());
  return {
    authDir, state, fake, connection, sockets, configs, timerJobs, received, opened, qrs, errors, logs,
    counts: () => ({ disconnects, authLoads, saves }),
    async fireTimer() {
      const [id, job] = timerJobs.entries().next().value;
      timerJobs.delete(id);
      job.callback();
      await flush();
    },
    close(status = 428, socket = sockets.at(-1)) {
      socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: status } } } });
    },
  };
}

test('opens one private auth state with no full history or recent-message cache', async t => {
  const f = await fixture(t);
  await Promise.all([f.connection.start(), f.connection.start()]);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.counts().authLoads, 1);
  assert.equal((await stat(f.authDir)).mode & 0o777, 0o700);
  const config = f.configs[0];
  assert.equal(config.syncFullHistory, false);
  assert.equal(config.enableRecentMessageCache, false);
  assert.equal(config.markOnlineOnConnect, false);
  assert.equal(config.emitOwnEvents, false);
  assert.equal(config.logger.level, 'silent');
  assert.equal(config.shouldSyncHistoryMessage({ syncType: 6 }), true);
  for (const syncType of [undefined, 0, 1, 2, 3, 4, 5, '6']) {
    assert.equal(config.shouldSyncHistoryMessage({ syncType }), false);
  }
  assert.deepEqual(f.connection.getOwnIds(), ['123@s.whatsapp.net', '987@lid']);
  f.sockets[0].ev.emit('connection.update', { qr: 'private-qr-fixture', connection: 'open' });
  assert.deepEqual(f.qrs, ['private-qr-fixture']);
  assert.deepEqual(f.opened, f.sockets);
  assert.equal(await config.getMessage({}), undefined);
});

test('only live notify events reach the command handler; replay and history events are ignored', async t => {
  const f = await fixture(t);
  await f.connection.start();
  const message = { key: { id: 'command' } };
  const events = f.sockets[0].ev;
  events.emit('messages.upsert', { type: 'append', messages: [message] });
  events.emit('messages.upsert', { type: 'notify', requestId: 'history-session', messages: [message] });
  events.emit('messaging-history.set', { messages: [message] });
  events.emit('messages.upsert', { type: 'notify', messages: null });
  events.emit('messages.upsert', { type: 'notify', messages: [message] });
  assert.deepEqual(f.received, [[message]]);
});

test('temporary disconnections reconnect with capped backoff and discard old socket listeners', async t => {
  const f = await fixture(t, { reconnectBaseMs: 100, reconnectMaxMs: 250 });
  await f.connection.start();
  const old = f.sockets[0];
  f.close();
  assert.equal(f.connection.getSocket(), undefined);
  assert.equal(f.timerJobs.size, 1);
  assert.equal([...f.timerJobs.values()][0].delay, 100);
  old.ev.emit('connection.update', { connection: 'open', qr: 'stale-qr' });
  old.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'stale' } }] });
  await f.fireTimer();
  assert.equal(f.sockets.length, 2);
  assert.equal(old.ended, 1);
  assert.equal(old.loggedOut, 0);
  assert.equal(f.received.length, 0);
  assert.equal(f.qrs.length, 0);
  assert.equal(f.counts().authLoads, 1);
  f.close();
  assert.equal([...f.timerJobs.values()][0].delay, 200);
  await f.fireTimer();
  f.close();
  assert.equal([...f.timerJobs.values()][0].delay, 250);
  await f.fireTimer();
  f.sockets.at(-1).ev.emit('connection.update', { connection: 'open' });
  f.close();
  assert.equal([...f.timerJobs.values()][0].delay, 100);
});

test('content edits and deletions erase retained content while receipt updates do not', async t => {
  const changed = [];
  const cleared = [];
  const f = await fixture(t, {
    onMessageChanges: keys => changed.push(keys),
    onChatMessagesDeleted: jid => cleared.push(jid),
  });
  await f.connection.start();
  const events = f.sockets[0].ev;
  const key = { remoteJid: '123-456@g.us', id: 'message', fromMe: false };
  events.emit('messages.update', [{ key, update: { status: 4 } }]);
  assert.equal(changed.length, 0);
  events.emit('messages.update', [{ key, update: { message: null, messageStubType: 1 } }]);
  events.emit('messages.update', [{ key, update: { message: { conversation: 'edited' } } }]);
  events.emit('messages.delete', { keys: [key] });
  events.emit('messages.delete', { all: true, jid: key.remoteJid });
  assert.deepEqual(changed, [[key], [key], [key]]);
  assert.deepEqual(cleared, [key.remoteJid]);
  f.close();
  events.emit('messages.update', [{ key, update: { message: null } }]);
  events.emit('messages.delete', { all: true, jid: key.remoteJid });
  assert.equal(changed.length, 3);
  assert.equal(cleared.length, 1);
  assert.equal(events.listenerCount('messages.update'), 0);
  assert.equal(events.listenerCount('messages.delete'), 0);
});

test('restart-required reconnects without deleting credentials and repeated failures are bounded', async t => {
  const f = await fixture(t, { maxReconnectAttempts: 2 });
  await f.connection.start();
  await writeFile(path.join(f.authDir, 'credential-fixture'), 'keep');
  f.close(515);
  assert.equal([...f.timerJobs.values()][0].delay, 500);
  await f.fireTimer();
  f.close(515);
  await f.fireTimer();
  f.close(515);
  assert.deepEqual(f.errors, ['WHATSAPP_RECONNECT_FAILED']);
  assert.equal(f.timerJobs.size, 0);
  assert.ok(await stat(path.join(f.authDir, 'credential-fixture')));
  assert.ok(f.sockets.every(socket => socket.loggedOut === 0));
});

test('logout, invalid sessions and account replacement stop rather than repeatedly reconnecting', async t => {
  for (const [status, code] of [
    [401, 'WHATSAPP_LOGGED_OUT'], [500, 'WHATSAPP_SESSION_INVALID'],
    [440, 'WHATSAPP_CONNECTION_REPLACED'], [403, 'WHATSAPP_FORBIDDEN'],
    [411, 'WHATSAPP_SESSION_INVALID'],
  ]) {
    const f = await fixture(t);
    await f.connection.start();
    f.close(status);
    await flush();
    assert.deepEqual(f.errors, [code]);
    assert.equal(f.timerJobs.size, 0);
    assert.equal(f.connection.getSocket(), undefined);
    assert.equal(f.sockets[0].ended, 1);
    assert.equal(f.sockets[0].loggedOut, 0);
    await assert.rejects(f.connection.start(), /stopped/);
  }
});

test('credential saves are serialized and stop flushes queued saves', async t => {
  const finish = [];
  let pending = 0;
  let maximum = 0;
  let saves = 0;
  const f = await fixture(t, { saveCreds: async () => {
    saves++;
    maximum = Math.max(maximum, ++pending);
    await new Promise(resolve => finish.push(resolve));
    pending--;
  } });
  await f.connection.start();
  f.sockets[0].ev.emit('creds.update', {});
  f.sockets[0].ev.emit('creds.update', {});
  await flush();
  assert.equal(saves, 1);
  const stopped = f.connection.stop();
  let complete = false;
  stopped.then(() => { complete = true; });
  await flush();
  assert.equal(complete, false);
  finish.shift()();
  await flush();
  assert.equal(saves, 2);
  finish.shift()();
  await stopped;
  assert.equal(maximum, 1);
  assert.equal(f.sockets[0].ended, 1);
  assert.equal(f.sockets[0].ev.listenerCount('creds.update'), 0);
});

test('credential persistence failures report only a safe code and prevent reconnection', async t => {
  const f = await fixture(t, { saveCreds: async () => { throw new Error('private credential content'); } });
  await f.connection.start();
  f.sockets[0].ev.emit('creds.update', {});
  await flush();
  assert.deepEqual(f.errors, ['WHATSAPP_AUTH_SAVE_FAILED']);
  assert.equal(f.connection.getSocket(), undefined);
  assert.equal(f.timerJobs.size, 0);
  assert.doesNotMatch(f.logs.join('\n'), /private credential/);
});

test('stop cancels reconnects and never logs out the linked device', async t => {
  const f = await fixture(t);
  await f.connection.start();
  f.close();
  assert.equal(f.timerJobs.size, 1);
  await f.connection.stop();
  await f.connection.stop();
  assert.equal(f.timerJobs.size, 0);
  assert.equal(f.sockets[0].loggedOut, 0);
  assert.equal(f.sockets[0].ended, 1);
  assert.equal(f.connection.getSocket(), undefined);
});

test('stopping during dependency initialization cannot create a late socket', async t => {
  let ready;
  const delayed = new Promise(resolve => { ready = resolve; });
  const f = await fixture(t, { loadDependencies: () => delayed });
  const starting = f.connection.start();
  const stopped = f.connection.stop();
  ready(f.fake);
  await Promise.all([starting, stopped]);
  assert.equal(f.sockets.length, 0);
});

test('callbacks and message retry misses cannot leak raw errors or crash the emitter', async t => {
  const f = await fixture(t, {
    onMessages: async () => { throw new Error('private message'); },
    onQR: () => { throw new Error('private QR'); },
    getMessage: async () => { throw new Error('private cached text'); },
  });
  await f.connection.start();
  f.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{}] });
  f.sockets[0].ev.emit('connection.update', { qr: 'secret' });
  assert.equal(await f.configs[0].getMessage({}), undefined);
  await flush();
  assert.equal(f.logs.length, 2);
  assert.doesNotMatch(f.logs.join('\n'), /private|secret/);
});

test('authentication directory symlinks are rejected before loading credentials', async t => {
  const f = await fixture(t);
  const link = `${f.authDir}-link`;
  await symlink(f.authDir, link, 'dir');
  t.after(() => rm(link, { force: true }));
  let loaded = false;
  const connection = createWhatsAppConnection({ authDir: link, loadDependencies: async () => { loaded = true; return f.fake; } });
  await assert.rejects(connection.start(), { code: 'WHATSAPP_START_FAILED' });
  await connection.stop();
  assert.equal(loaded, false);
});
