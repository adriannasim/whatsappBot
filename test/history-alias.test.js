import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventBuffer, processHistoryMessage, proto } from '@whiskeysockets/baileys';
import { createOnDemandHistory } from '../src/history.js';

const GROUP = '123@g.us';
const PN = '456@s.whatsapp.net';
const LID = '789@lid';
const row = (id, participant = PN, timestamp = 1000, fromMe = false) => ({
  key: { remoteJid: GROUP, id, participant, fromMe },
  messageTimestamp: timestamp, message: { conversation: id },
});
const request = overrides => ({
  groupId: GROUP, startId: 'anchor', startParticipant: LID, startFromMe: false,
  endKey: row('command').key, endTimestamp: 1000, ...overrides,
});

function fixture(t, rows, mapping, options = {}) {
  const ev = makeEventBuffer({ debug() {}, trace() {}, warn() {} });
  const originalEmit = ev.emit;
  let calls = 0;
  const socket = {
    ev, signalRepository: { lidMapping: mapping },
    async fetchMessageHistory() {
      const session = `request-${++calls}`;
      const decoded = proto.HistorySync.decode(proto.HistorySync.encode({
        syncType: 6, progress: 100,
        conversations: [{ id: GROUP, messages: (calls === 1 ? rows : []).map(message => ({ message })) }],
      }).finish());
      ev.buffer();
      ev.emit('messaging-history.set', { ...processHistoryMessage(decoded), peerDataRequestSessionId: session });
      ev.flush();
      return session;
    },
  };
  const history = createOnDemandHistory({ getSocket: () => socket, timeoutMs: 200, settleMs: 1, ...options });
  t.after(() => { history.close(); ev.destroy(); });
  return { history, ev, originalEmit };
}

test('a LID quote matches a PN history anchor only through the verified mapping', async t => {
  const lookups = [];
  const f = fixture(t, [row('middle', '111@s.whatsapp.net'), row('anchor')], {
    async getPNForLID(value) { lookups.push(value); return '456:3@s.whatsapp.net'; },
    async getLIDForPN() { assert.fail('Unexpected lookup direction'); },
  });
  const result = await f.history.load(request());
  assert.deepEqual(result.map(message => message.key.id), ['anchor', 'middle']);
  assert.deepEqual(lookups, [LID]);
  assert.equal(result[0].key.participantAlt, undefined);
  assert.equal(f.ev.emit, f.originalEmit);
});

test('a PN quote matches a LID history anchor through the reverse verified mapping', async t => {
  const lookups = [];
  const f = fixture(t, [row('anchor', LID)], {
    async getLIDForPN(value) { lookups.push(value); return LID; },
  });
  assert.equal((await f.history.load(request({ startParticipant: PN })))[0].key.participant, LID);
  assert.deepEqual(lookups, [PN]);
});

test('a verified cursor alias excludes the command and later messages in the same second', async t => {
  const lookups = [];
  const f = fixture(t, [row('later'), row('command'), row('middle'), row('anchor')], {
    async getPNForLID(value) { lookups.push(value); return PN; },
  });
  const result = await f.history.load(request({ endKey: row('command', LID).key }));
  assert.deepEqual(result.map(message => message.key.id), ['anchor', 'middle']);
  assert.deepEqual(lookups, [LID, LID]);
});

test('an unverified cursor sender fails instead of including later messages in the same second', async t => {
  const f = fixture(t, [row('later'), row('command'), row('anchor')], {
    async getPNForLID() { return null; },
  });
  await assert.rejects(f.history.load(request({ endKey: row('command', LID).key })), {
    code: 'HISTORY_UNAVAILABLE', message: /history boundary whose sender could not be verified/,
  });
  assert.equal(f.ev.emit, f.originalEmit);
});

test('direct participant matches do not perform identity lookups', async t => {
  const f = fixture(t, [row('anchor')], {
    async getPNForLID() { assert.fail('Unexpected lookup'); },
    async getLIDForPN() { assert.fail('Unexpected lookup'); },
  });
  assert.equal((await f.history.load(request({ startParticipant: PN }))).length, 1);
});

test('missing, failed and mismatched mappings cannot authorize a different anchor sender', async t => {
  for (const [name, lookup] of Object.entries({
    absent: undefined,
    missing: async () => null,
    mismatch: async () => '999@s.whatsapp.net',
    failure: async () => { throw new Error('Mapping unavailable'); },
  })) {
    await t.test(name, async subtest => {
      const f = fixture(subtest, [row('anchor')], { getPNForLID: lookup });
      await assert.rejects(f.history.load(request()), { code: 'HISTORY_UNAVAILABLE', message: /starting message but its sender could not be verified/ });
      assert.equal(f.ev.emit, f.originalEmit);
    });
  }
});

test('aliases cannot override a required fromMe value', async t => {
  for (const startFromMe of [true, false]) {
    await t.test(String(startFromMe), async subtest => {
      const f = fixture(subtest, [row('anchor', PN, 1000, !startFromMe)], {
        async getPNForLID() { assert.fail('Sender direction must be checked before lookup'); },
      });
      await assert.rejects(f.history.load(request({ startFromMe })), { code: 'HISTORY_UNAVAILABLE' });
    });
  }
});

test('a hung alias lookup is bounded by the history deadline and releases the observer', async t => {
  const f = fixture(t, [row('anchor')], {
    getPNForLID() { return new Promise(() => {}); },
  }, { timeoutMs: 25 });
  await assert.rejects(f.history.load(request()), { code: 'HISTORY_UNAVAILABLE', message: /did not finish/ });
  assert.equal(f.ev.emit, f.originalEmit);
});

test('closing during an alias lookup releases the observer immediately', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, [row('anchor')], {
    getPNForLID() { entered(); return new Promise(() => {}); },
  });
  const pending = f.history.load(request());
  await started;
  f.history.close();
  await assert.rejects(pending, { code: 'HISTORY_UNAVAILABLE', message: /closed/ });
  assert.equal(f.ev.emit, f.originalEmit);
});
