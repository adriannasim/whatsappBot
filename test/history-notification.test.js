import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadAndProcessHistorySyncNotification, proto } from '@whiskeysockets/baileys';
import { createOnDemandHistory } from '../src/history.js';

const GROUP = 'private-group@g.us';
const SECOND = 1_793_282_400;
const row = (id, timestamp = SECOND - 1) => ({
  key: { remoteJid: GROUP, id, fromMe: false, participant: 'private-sender@lid' },
  messageTimestamp: timestamp, message: { conversation: 'private message content' },
});
const request = () => ({ groupId: GROUP, startId: 'anchor', endKey: row('command', SECOND).key, endTimestamp: SECOND });

function chunk(ev, session, rows, { notificationProgress = 100, payloadProgress, order = 0, chat = {}, fromMe = true, type = proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION } = {}) {
  const payload = proto.HistorySync.encode({
    syncType: 6, ...(payloadProgress == null ? {} : { progress: payloadProgress }),
    conversations: [{ id: GROUP, ...chat, messages: rows.map(message => ({ message })) }],
  }).finish();
  const notification = proto.Message.HistorySyncNotification.decode(proto.Message.HistorySyncNotification.encode({
    syncType: 6, peerDataRequestSessionId: session,
    ...(notificationProgress == null ? {} : { progress: notificationProgress }),
    ...(order == null ? {} : { chunkOrder: order }),
    mediaKey: Buffer.from('private media key'),
    initialHistBootstrapInlinePayload: deflateSync(payload),
  }).finish());
  return {
    notify() {
      ev.emit('messages.upsert', { type: 'notify', messages: [{
        key: { fromMe }, message: { protocolMessage: { type, historySyncNotification: notification } },
      }] });
    },
    async body() {
      const data = await downloadAndProcessHistorySyncNotification(notification, {});
      // This is the exact rc14 emission shape: payload progress is used even
      // when notification.progress was present and payload progress was not.
      ev.emit('messaging-history.set', {
        ...data, chunkOrder: notification.chunkOrder, peerDataRequestSessionId: session,
      });
    },
  };
}

function fixture(t, handler, options = {}) {
  const source = new EventEmitter();
  const ev = options.emitless ? { on: source.on.bind(source), off: source.off.bind(source) } : source;
  const originalEmit = ev.emit;
  const calls = [];
  const diagnostics = [];
  const socket = {
    ev,
    async fetchMessageHistory(count, key, timestamp) {
      const session = `private-session-${calls.length + 1}`;
      calls.push({ count, key, timestamp });
      await handler({ ev: source, session, calls });
      return session;
    },
  };
  const history = createOnDemandHistory({
    getSocket: () => socket, settleMs: 2, emptyPageRetryMs: 0, timeoutMs: 500,
    onDiagnostic: value => { diagnostics.push(value); options.onDiagnostic?.(value); }, ...options,
  });
  t.after(() => history.close());
  return { history, calls, diagnostics, source, clean() {
    assert.equal(ev.emit, originalEmit);
    for (const name of ['messages.upsert', 'messaging-history.set', 'connection.update']) assert.equal(source.listenerCount(name), 0);
  } };
}

test('a first empty phone response retries the same seconds cursor once and can recover', async t => {
  const f = fixture(t, async ({ ev, session, calls }) => {
    const item = chunk(ev, session, calls.length === 1 ? [] : [row('anchor')], {
      chat: { endOfHistoryTransfer: true, endOfHistoryTransferType: 2 },
    });
    item.notify();
    await item.body();
  });
  assert.deepEqual((await f.history.load(request())).map(message => message.key.id), ['anchor']);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(f.calls[0].timestamp, SECOND);
  assert.deepEqual(f.diagnostics.map(value => value.reason), ['empty_page_retry', 'recovered_after_empty_page']);
  const first = f.diagnostics[0];
  assert.equal(first.payloadProgress, null);
  assert.equal(first.notificationProgress, 100);
  assert.equal(first.notificationChunkOrder, 0);
  assert.equal(first.chatCount, 1);
  assert.equal(first.matchingChatCount, 1);
  assert.equal(first.endOfHistoryTransfer, true);
  assert.equal(first.endOfHistoryTransferType, 2);
  assert.equal(f.diagnostics[1].retries, 1);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /private|@|"anchor"|media|1793282400/);
  f.clean();
});

test('a second empty page fails without another retry, while later exhaustion never retries', async t => {
  for (const firstEmpty of [true, false]) {
    const f = fixture(t, async ({ ev, session, calls }) => {
      const item = chunk(ev, session, !firstEmpty && calls.length === 1 ? [row('recent')] : []);
      item.notify();
      await item.body();
    });
    await assert.rejects(f.history.load(request()), /no earlier messages/);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.diagnostics.map(value => value.reason), firstEmpty ? ['empty_page_retry', 'empty_page'] : ['empty_page']);
    assert.equal(f.diagnostics.at(-1).retries, firstEmpty ? 1 : 0);
    f.clean();
  }
});

test('numbered notification progress waits for the final decoded payload after an empty intermediate chunk', async t => {
  let finalArrived = false;
  const f = fixture(t, async ({ ev, session }) => {
    const first = chunk(ev, session, [], { notificationProgress: 50, order: 0 });
    const last = chunk(ev, session, [row('anchor')], { notificationProgress: 100, order: 1 });
    first.notify();
    last.notify(); // Final notification can arrive before either download.
    await first.body();
    setTimeout(async () => { finalArrived = true; await last.body(); }, 30);
  });
  assert.equal((await f.history.load(request())).length, 1);
  assert.equal(finalArrived, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.diagnostics, []);
  f.clean();
});

test('explicit payload completion takes precedence over notification fallback', async t => {
  const f = fixture(t, async ({ ev, session }) => {
    const item = chunk(ev, session, [row('anchor')], { notificationProgress: 50, payloadProgress: 100 });
    item.notify();
    await item.body();
  });
  assert.equal((await f.history.load(request())).length, 1);
  f.clean();
});

test('spoofed, unrelated and wrong-type notifications cannot block a valid response', async t => {
  const f = fixture(t, async ({ ev, session }) => {
    chunk(ev, session, [], { notificationProgress: 0, fromMe: false }).notify();
    chunk(ev, session, [], { notificationProgress: 0, type: proto.Message.ProtocolMessage.Type.REVOKE }).notify();
    chunk(ev, 'private-other-session', [], { notificationProgress: 0 }).notify();
    const item = chunk(ev, session, [row('anchor')]);
    await item.body();
  });
  assert.equal((await f.history.load(request())).length, 1);
  assert.equal(f.calls.length, 1);
  f.clean();
});

test('an unfinished notification times out with safe progress diagnostics and no retry', async t => {
  const f = fixture(t, async ({ ev, session }) => {
    const item = chunk(ev, session, [], { notificationProgress: 50 });
    item.notify();
    await item.body();
  }, { timeoutMs: 40 });
  await assert.rejects(f.history.load(request()), /did not finish/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.diagnostics[0].reason, 'timeout');
  assert.equal(f.diagnostics[0].notificationProgress, 50);
  assert.equal(f.diagnostics[0].payloadProgress, null);
  assert.equal(f.diagnostics[0].retries, 0);
  f.clean();
});

test('timeout, disconnect and close interrupt the retry delay and release observers', async t => {
  for (const action of ['timeout', 'disconnect', 'close']) {
    let started;
    const retryStarted = new Promise(resolve => { started = resolve; });
    const f = fixture(t, async ({ ev, session }) => {
      const item = chunk(ev, session, []);
      item.notify();
      await item.body();
    }, {
      emptyPageRetryMs: 10_000, timeoutMs: action === 'timeout' ? 35 : 1000,
      onDiagnostic: value => { if (value.reason === 'empty_page_retry') started(); },
    });
    const pending = f.history.load(request());
    await retryStarted;
    if (action === 'disconnect') f.source.emit('connection.update', { connection: 'close' });
    if (action === 'close') f.history.close();
    await assert.rejects(pending, /did not finish|disconnected|closed/);
    assert.equal(f.calls.length, 1);
    f.clean();
  }
});

test('emit-less adapters observe notification progress and clean up both subscriptions', async t => {
  const f = fixture(t, async ({ ev, session }) => {
    const item = chunk(ev, session, [row('anchor')]);
    item.notify();
    await item.body();
  }, { emitless: true });
  assert.equal((await f.history.load(request())).length, 1);
  f.clean();
});

test('multiple unnumbered notifications cannot borrow an earlier completed payload while a download is pending', async t => {
  let finalArrived = false;
  const f = fixture(t, async ({ ev, session }) => {
    const first = chunk(ev, session, [], { order: null, payloadProgress: 100 });
    const last = chunk(ev, session, [row('anchor')], { order: null, payloadProgress: 100 });
    first.notify();
    await first.body();
    last.notify();
    setTimeout(async () => { finalArrived = true; await last.body(); }, 30);
  });
  assert.equal((await f.history.load(request())).length, 1);
  assert.equal(finalArrived, true);
  assert.equal(f.calls.length, 1);
  f.clean();
});

test('a superseded empty response cannot supply rows to the retry session', async t => {
  const f = fixture(t, async ({ ev, session, calls }) => {
    const item = chunk(ev, session, calls.length === 1 ? [] : [row('anchor')]);
    item.notify();
    await item.body();
    if (calls.length === 1) setTimeout(async () => {
      const late = chunk(ev, session, [row('private-late-row')]);
      late.notify();
      await late.body();
    }, 10);
  }, { emptyPageRetryMs: 30 });
  assert.deepEqual((await f.history.load(request())).map(message => message.key.id), ['anchor']);
  assert.equal(f.calls.length, 2);
  await delay(1);
  f.clean();
});
