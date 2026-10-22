import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createOnDemandHistory } from '../src/history.js';

const GROUP = 'friends@g.us';
const OTHER_GROUP = 'elsewhere@g.us';
const message = (id, timestamp = 1000, groupId = GROUP, participant = 'friend@s.whatsapp.net') => ({
  key: { id: String(id), remoteJid: groupId, fromMe: false, participant },
  messageTimestamp: timestamp,
  message: { conversation: `Message ${id}` },
});
const ids = (messages) => messages.map((item) => item.key.id);
const request = (overrides = {}) => ({ groupId: GROUP, startId: 'anchor', endKey: message('command').key, endTimestamp: 1000, ...overrides });

function setup(handler, options = {}) {
  const ev = new EventEmitter();
  const calls = [];
  const emit = (session, messages, extra = {}) => ev.emit('messaging-history.set', {
    syncType: 6, peerDataRequestSessionId: session, messages, ...extra,
  });
  const socket = {
    ev,
    async fetchMessageHistory(count, key, timestampMs) {
      const session = `request-${calls.length + 1}`;
      calls.push({ count, key, timestampMs, session });
      await handler?.({ count, key, timestampMs, session, emit, calls, ev });
      return session;
    },
  };
  const history = createOnDemandHistory({ getSocket: () => socket, settleMs: 1, timeoutMs: 150, ...options });
  return { history, socket, ev, emit, calls };
}

function assertClean(ev) {
  assert.equal(ev.listenerCount('messaging-history.set'), 0);
  assert.equal(ev.listenerCount('connection.update'), 0);
}

test('handles an event before the request ID resolves, includes anchor and excludes command/later timestamp ties', async () => {
  const rows = ['later', 'command', 'middle', 'anchor', 'before'].map((id) => message(id));
  const { history, calls, ev } = setup(({ session, emit }) => emit(session, rows, { progress: 100 }));
  const result = await history.load(request());
  assert.deepEqual(ids(result), ['anchor', 'middle']);
  assert.equal(result[0], rows[3]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls[0].timestampMs, 1000000);
  assert.equal(calls[0].key.id, 'command');
  assert.deepEqual(ids(rows), ['later', 'command', 'middle', 'anchor', 'before']);
  assertClean(ev);
  history.close();
});

test('pages backwards using each oldest actual key and retains equal-second protocol order', async () => {
  const { history, calls, ev } = setup(({ session, emit, calls }) => {
    emit(session, calls.length === 1
      ? [message('newer'), message('middle')]
      : [message('middle'), message('anchor'), message('before')]);
  });
  assert.deepEqual(ids(await history.load(request())), ['anchor', 'middle', 'newer']);
  assert.deepEqual(calls.map((call) => call.key.id), ['command', 'middle']);
  assert.deepEqual(calls.map((call) => call.timestampMs), [1000000, 1000000]);
  assertClean(ev);
});

test('ignores other sessions, sync types, uncorrelated events and groups', async () => {
  const { history, ev } = setup(({ session, emit }) => {
    emit('wrong-session', [message('anchor')]);
    emit(session, [message('anchor')], { syncType: 0 });
    emit(session, [message('anchor', 1000, OTHER_GROUP)]);
    emit(session, [message('anchor')], { peerDataRequestSessionId: undefined });
    emit(session, [message('middle'), message('anchor')], { progress: 100 });
  });
  assert.deepEqual(ids(await history.load(request())), ['anchor', 'middle']);
  assertClean(ev);
});

test('waits for fragmented progress even when the quiet interval elapses', async () => {
  let emittedFinal = false;
  const { history } = setup(({ session, emit }) => {
    emit(session, [message('middle', 999)], { progress: 50, chunkOrder: 0 });
    setTimeout(() => {
      emittedFinal = true;
      emit(session, [message('anchor', 998)], { progress: 100, chunkOrder: 1 });
    }, 20);
  });
  assert.deepEqual(ids(await history.load(request())), ['anchor', 'middle']);
  assert.equal(emittedFinal, true);
});

test('does not turn an explicitly incomplete response into a successful partial summary', async () => {
  const { history, calls, ev } = setup(({ session, emit }) => {
    emit(session, [message('anchor')], { progress: 50 });
  }, { timeoutMs: 25 });
  await assert.rejects(history.load(request()), { code: 'HISTORY_UNAVAILABLE', message: /did not finish/ });
  assert.equal(calls.length, 1);
  assertClean(ev);
});

test('uses chunk order to restore fragmented reverse chronological pages and deduplicates redelivery', async () => {
  const { history } = setup(({ session, emit }) => {
    emit(session, [message('anchor', 998)], { progress: 100, chunkOrder: 1 });
    emit(session, [message('middle', 999)], { progress: 50, chunkOrder: 0 });
    emit(session, [message('middle', 999)], { progress: 50, chunkOrder: 0 });
  });
  assert.deepEqual(ids(await history.load(request())), ['anchor', 'middle']);
});

test('missing progress uses a quiet interval and extends it when another chunk arrives', async () => {
  const { history } = setup(({ session, emit }) => {
    emit(session, [message('middle', 999)]);
    setTimeout(() => emit(session, [message('anchor', 998)]), 5);
  }, { settleMs: 15 });
  assert.deepEqual(ids(await history.load(request())), ['anchor', 'middle']);
});

test('caps the requested range and fails instead of silently truncating it', async () => {
  const { history, calls, ev } = setup(({ session, emit, calls }) => {
    emit(session, calls.length === 1 ? [message('one'), message('two')] : [message('three')]);
  }, { maxMessages: 3 });
  await assert.rejects(history.load(request()), { code: 'HISTORY_UNAVAILABLE', message: /starting message/ });
  assert.deepEqual(calls.map((call) => call.count), [3, 1]);
  assert.deepEqual(calls.map((call) => call.key.id), ['command', 'two']);
  assertClean(ev);
});

test('accepts an anchor exactly at the configured range cap', async () => {
  const { history, calls } = setup(({ session, emit }) => emit(session, [message('middle'), message('anchor')]), { maxMessages: 2 });
  assert.deepEqual(ids(await history.load(request())), ['anchor', 'middle']);
  assert.equal(calls[0].count, 2);
});

test('stops when a page cannot move the cursor or history is empty', async () => {
  for (const empty of [false, true]) {
    const { history, calls, ev } = setup(({ session, emit, calls }) => {
      emit(session, calls.length === 1 ? [message('recent')] : (empty ? [] : [message('recent')]));
    });
    await assert.rejects(history.load(request()), { code: 'HISTORY_UNAVAILABLE' });
    assert.equal(calls.length, 2);
    assertClean(ev);
  }
});

test('rejects future, reversed and malformed timestamps rather than manufacturing order', async () => {
  for (const rows of [
    [message('anchor', 1001)],
    [message('middle', 998), message('anchor', 999)],
    [message('anchor', NaN)],
    [message('anchor', '1000')],
    [message('anchor', -1)],
    [message('anchor', 1.5)],
  ]) {
    const { history, ev } = setup(({ session, emit }) => emit(session, rows));
    await assert.rejects(history.load(request()), { code: 'HISTORY_UNAVAILABLE' });
    assertClean(ev);
  }
});

test('understands protobuf Long timestamps and converts the cursor to milliseconds', async () => {
  const { history, calls } = setup(({ session, emit }) => emit(session, [message('anchor', { low: 999, high: 0, unsigned: true })]));
  assert.deepEqual(ids(await history.load(request({ endTimestamp: { toNumber: () => 1000 } }))), ['anchor']);
  assert.equal(calls[0].timestampMs, 1000000);
});

test('matches an explicitly supplied anchor participant including device suffix and alternate PN', async () => {
  const anchor = message('anchor', 999, GROUP, '123@lid');
  anchor.key.participantAlt = '456:7@s.whatsapp.net';
  const { history } = setup(({ session, emit }) => emit(session, [anchor]));
  assert.deepEqual(ids(await history.load(request({ startParticipant: '456@s.whatsapp.net' }))), ['anchor']);
  const mismatch = setup(({ session, emit, calls }) => emit(session, calls.length === 1 ? [anchor] : []));
  await assert.rejects(mismatch.history.load(request({ startParticipant: 'someone-else@lid' })), { code: 'HISTORY_UNAVAILABLE' });
});

test('serializes requests across groups and resolves the socket when each queued request starts', async () => {
  const first = setup(() => {});
  const second = setup(({ session, emit }) => emit(session, [message('anchor', 999, OTHER_GROUP)]));
  let currentSocket = first.socket;
  const history = createOnDemandHistory({ getSocket: () => currentSocket, timeoutMs: 150, settleMs: 1 });
  const one = history.load(request());
  const two = history.load(request({ groupId: OTHER_GROUP, endKey: message('command', 1000, OTHER_GROUP).key }));
  await delay(1);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
  currentSocket = second.socket;
  first.emit('request-1', [message('anchor', 999)]);
  assert.deepEqual(ids(await one), ['anchor']);
  assert.deepEqual(ids(await two), ['anchor']);
  assert.equal(second.calls.length, 1);
  assertClean(first.ev);
  assertClean(second.ev);
});

test('a verified own-message anchor can omit participant but still must have fromMe true', async () => {
  const anchor = message('anchor', 999);
  anchor.key.fromMe = true;
  delete anchor.key.participant;
  const own = setup(({ session, emit }) => emit(session, [message('middle'), anchor]));
  assert.deepEqual(ids(await own.history.load(request({ startParticipant: 'bot@s.whatsapp.net', startFromMe: true }))), ['anchor', 'middle']);
  const other = setup(({ session, emit, calls }) => emit(session, calls.length === 1 ? [message('anchor')] : []));
  await assert.rejects(other.history.load(request({ startFromMe: true })), { code: 'HISTORY_UNAVAILABLE' });
});

test('times out missing events and a stuck request-ID promise with listener cleanup', async () => {
  for (const stuckPromise of [false, true]) {
    const { history, ev } = setup(() => stuckPromise ? new Promise(() => {}) : undefined, { timeoutMs: 20 });
    await assert.rejects(history.load(request()), { code: 'HISTORY_UNAVAILABLE', message: /phone online/ });
    assertClean(ev);
  }
});

test('fails the active request on disconnect and cleans up its listeners', async () => {
  const { history, ev } = setup(({ ev }) => ev.emit('connection.update', { connection: 'close' }));
  await assert.rejects(history.load(request()), { code: 'HISTORY_UNAVAILABLE', message: /disconnected/ });
  assertClean(ev);
});

test('close rejects active and queued requests and never starts the queued fetch', async () => {
  const { history, ev, calls } = setup(() => {});
  const results = Promise.allSettled([history.load(request()), history.load(request())]);
  await delay(1);
  history.close();
  history.close();
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'HISTORY_UNAVAILABLE');
  }
  assert.equal(calls.length, 1);
  await assert.rejects(history.load(request()), /closed/);
  assertClean(ev);
});

test('closing immediately prevents the scheduled fetch from being sent', async () => {
  const { history, calls, ev } = setup(() => {});
  const pending = history.load(request());
  history.close();
  await assert.rejects(pending, /closed/);
  assert.equal(calls.length, 0);
  assertClean(ev);
});

test('rejects oversized command-scoped buffers and malformed matching response data', async () => {
  for (const rows of [
    null,
    [{ key: { remoteJid: GROUP, id: 'anchor' }, messageTimestamp: 999 }],
    [{ ...message('anchor'), message: { conversation: 'x'.repeat(9 * 1024 * 1024) } }],
    Array.from({ length: 102 }, (_, index) => message(index)),
  ]) {
    const { history, ev } = setup(({ session, emit }) => emit(session, rows), { maxMessages: 1 });
    await assert.rejects(history.load(request()), { code: 'HISTORY_UNAVAILABLE' });
    assertClean(ev);
  }
});

test('does not listen to or retain history while idle and ignores old sessions on later requests', async () => {
  const { history, ev, emit } = setup(({ session, emit }) => {
    emit('request-0', [message('wrong')]);
    emit(session, [message('anchor')]);
  });
  assertClean(ev);
  emit('request-0', [message('idle')]);
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(ids(await history.load(request())), ['anchor']);
    assertClean(ev);
  }
});

test('validates configuration and requires actual command boundaries', async () => {
  assert.throws(() => createOnDemandHistory(), /getSocket/);
  for (const maxMessages of [0, -1, 1.5, Infinity, '100']) {
    assert.throws(() => createOnDemandHistory({ getSocket: () => ({}), maxMessages }), /maxMessages/);
  }
  for (const [name, value] of [['timeoutMs', 0], ['settleMs', -1], ['onDemandType', -1]]) {
    assert.throws(() => createOnDemandHistory({ getSocket: () => ({}), [name]: value }), new RegExp(name));
  }
  const { history, calls } = setup(() => {});
  for (const options of [
    request({ groupId: 'person@s.whatsapp.net' }),
    request({ startId: '' }),
    request({ startId: 'command' }),
    request({ endKey: { id: 'command', remoteJid: OTHER_GROUP, fromMe: false } }),
    request({ endKey: { id: 'command', remoteJid: GROUP } }),
    request({ endTimestamp: NaN }),
  ]) await assert.rejects(history.load(options));
  assert.equal(calls.length, 0);
  const offline = createOnDemandHistory({ getSocket: () => undefined });
  await assert.rejects(offline.load(request()), { code: 'HISTORY_UNAVAILABLE', message: /not connected/ });
});
