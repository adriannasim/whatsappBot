import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeEventBuffer, processHistoryMessage, proto } from '@whiskeysockets/baileys';
import { createOnDemandHistory } from '../src/history.js';

const GROUP = '123@g.us';
const message = (id, timestamp) => ({
  key: { remoteJid: GROUP, id, fromMe: false, participant: '456@s.whatsapp.net' },
  messageTimestamp: timestamp,
  message: { conversation: `Message ${id}` },
});
const request = () => ({
  groupId: GROUP, startId: 'anchor', endKey: message('command', 1004).key, endTimestamp: 1004,
});
const ids = rows => rows.map(row => row.key.id);
const logger = { debug() {}, trace() {}, warn() {} };

// Exercise the pinned Baileys protobuf decoder and event buffer instead of
// assuming that its public history event preserves each raw response.
function historyEvent(session, messages, { progress, chunkOrder } = {}) {
  const decoded = proto.HistorySync.decode(proto.HistorySync.encode({
    syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
    ...(progress == null ? {} : { progress }),
    conversations: [{ id: GROUP, messages: messages.map(value => ({ message: value })) }],
  }).finish());
  return { ...processHistoryMessage(decoded), peerDataRequestSessionId: session, chunkOrder };
}

function fixture(t, handler, options = {}) {
  const ev = makeEventBuffer(logger);
  const originalEmit = ev.emit;
  const delivered = [];
  const calls = [];
  ev.on('messaging-history.set', event => delivered.push(event));
  const socket = {
    ev,
    async fetchMessageHistory(count, key, timestampMs) {
      const session = `request-${calls.length + 1}`;
      calls.push({ count, key, timestampMs, session });
      await handler({ ev, calls, session, emit: (rows, extra) => ev.emit('messaging-history.set', historyEvent(session, rows, extra)) });
      return session;
    },
  };
  const history = createOnDemandHistory({ getSocket: () => socket, settleMs: 1, timeoutMs: 250, ...options });
  t.after(() => { history.close(); ev.destroy(); });
  return { ev, socket, originalEmit, delivered, calls, history };
}

test('repeated and overlapping commands receive history that Baileys deduplicates for buffered consumers', async t => {
  const anchor = message('anchor', 1001);
  const middle = message('middle', 1002);
  const newer = message('newer', 1003);
  const f = fixture(t, ({ ev, calls, emit }) => {
    ev.buffer();
    emit(calls.length === 1 ? [middle, anchor] : [newer, middle, anchor], { progress: 100 });
    ev.flush();
  });
  assert.deepEqual(ids(await f.history.load(request())), ['anchor', 'middle']);
  assert.equal(f.ev.emit, f.originalEmit);
  assert.deepEqual(ids(await f.history.load(request())), ['anchor', 'middle', 'newer']);
  assert.equal(f.ev.emit, f.originalEmit);
  assert.deepEqual(ids(await f.history.load(request())), ['anchor', 'middle', 'newer']);
  assert.equal(f.ev.emit, f.originalEmit);
  // The original buffer still behaves normally for its existing consumers.
  assert.deepEqual(f.delivered.map(event => ids(event.messages)), [['middle', 'anchor'], ['newer'], []]);
});

test('raw session and chunk metadata survive a buffer that merges unrelated sessions and out-of-order chunks', async t => {
  const f = fixture(t, ({ ev, emit }) => {
    ev.buffer();
    emit([message('anchor', 1001)], { progress: 100, chunkOrder: 1 });
    emit([message('middle', 1002)], { progress: 50, chunkOrder: 0 });
    ev.emit('messaging-history.set', historyEvent('unrelated-session', [message('unrelated', 1000)], { progress: 100 }));
    ev.flush();
  });
  assert.deepEqual(ids(await f.history.load(request())), ['anchor', 'middle']);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0].peerDataRequestSessionId, 'unrelated-session');
  assert.deepEqual(ids(f.delivered[0].messages), ['anchor', 'middle', 'unrelated']);
  assert.equal(f.ev.emit, f.originalEmit);
});

test('omitted protobuf fromMe is normalized on a copy without changing buffered messages', async t => {
  const anchor = message('anchor', 1001);
  delete anchor.key.fromMe;
  const f = fixture(t, ({ ev, emit }) => {
    ev.buffer();
    emit([anchor], { progress: 100 });
    ev.flush();
  });
  const result = await f.history.load({ ...request(), startFromMe: false });
  assert.equal(result[0].key.fromMe, false);
  assert.equal(f.delivered[0].messages[0].key.fromMe, null);
  assert.notEqual(result[0], f.delivered[0].messages[0]);
  assert.notEqual(result[0].key, f.delivered[0].messages[0].key);
  assert.equal(result[0].messageTimestamp, f.delivered[0].messages[0].messageTimestamp);
  await assert.rejects(f.history.load({ ...request(), startFromMe: true }), { code: 'HISTORY_UNAVAILABLE' });
});

test('nonboolean nonempty fromMe values remain invalid', async t => {
  const f = fixture(t, ({ ev, session }) => {
    const event = historyEvent(session, [message('anchor', 1001)], { progress: 100 });
    event.messages[0].key.fromMe = 'false';
    ev.emit('messaging-history.set', event);
  });
  await assert.rejects(f.history.load(request()), { code: 'HISTORY_UNAVAILABLE', message: /valid key/ });
  assert.equal(f.ev.emit, f.originalEmit);
});

test('the scoped observer preserves emit receiver, arguments, return value, and unrelated events', async t => {
  const f = fixture(t, ({ ev, emit }) => {
    assert.equal(ev.emit('test.unrelated', marker, 'extra-argument'), true);
    assert.equal(ev.emit('test.without-listener', marker), true);
    ev.buffer();
    emit([message('anchor', 1001)]); // Actual protobuf missing progress is null.
    ev.flush();
  });
  const marker = { unchanged: true };
  const seen = [];
  const invocations = [];
  f.ev.on('test.unrelated', value => seen.push(value));
  const delegate = f.ev.emit;
  const original = function (...args) {
    invocations.push({ receiver: this, args });
    return Reflect.apply(delegate, this, args);
  };
  f.ev.emit = original;
  assert.deepEqual(ids(await f.history.load(request())), ['anchor']);
  assert.deepEqual(seen, [marker]);
  assert.deepEqual(invocations[0], { receiver: f.ev, args: ['test.unrelated', marker, 'extra-argument'] });
  assert.equal(f.ev.emit, original);
  assert.equal(f.delivered[0].progress, null);
});

test('the original emitter is restored after timeout, rejected fetch, malformed history, disconnect and close', async t => {
  const cases = {
    timeout: () => {},
    'rejected fetch': () => { throw new Error('Fetch failed'); },
    'malformed history': ({ ev, session }) => ev.emit('messaging-history.set', {
      syncType: 6, peerDataRequestSessionId: session, messages: [], progress: 101,
      chats: [], contacts: [],
    }),
    disconnect: ({ ev }) => ev.emit('connection.update', { connection: 'close' }),
    close: () => {},
  };
  for (const [name, handler] of Object.entries(cases)) {
    await t.test(name, async subtest => {
      const f = fixture(subtest, handler, { timeoutMs: 25 });
      const pending = f.history.load(request());
      if (name === 'close') f.history.close();
      await assert.rejects(pending);
      assert.equal(f.ev.emit, f.originalEmit);
    });
  }
});

test('emit-less adapters retain listener-based history support and cleanup', async () => {
  const source = new EventEmitter();
  const ev = { on: source.on.bind(source), off: source.off.bind(source) };
  const socket = {
    ev,
    async fetchMessageHistory() {
      source.emit('messaging-history.set', historyEvent('request', [message('anchor', 1001)]));
      return 'request';
    },
  };
  const history = createOnDemandHistory({ getSocket: () => socket, settleMs: 1, timeoutMs: 100 });
  try {
    assert.deepEqual(ids(await history.load(request())), ['anchor']);
    assert.equal(source.listenerCount('messaging-history.set'), 0);
    assert.equal(source.listenerCount('connection.update'), 0);
    assert.equal(ev.emit, undefined);
  } finally {
    history.close();
  }
});
