import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentMessageBuffer } from '../src/recent-messages.js';
import { extractContent, normalizeMessages } from '../src/adapter.js';

const GROUP = '123456-789@g.us';
const OTHER = '987654-321@g.us';
const SECONDS = 1_800_000_000;
const PERSON = '123@s.whatsapp.net';
function message(id, extra = {}) {
  return {
    key: { remoteJid: GROUP, id, fromMe: false, participant: '123:7@s.whatsapp.net', participantAlt: '456:8@lid' },
    messageTimestamp: SECONDS, pushName: 'Alice', message: { conversation: `Text ${id}` }, ...extra,
  };
}
function request(startId = 'anchor', end = message('command'), extra = {}) {
  return { groupId: end.key.remoteJid, startId, startParticipant: PERSON, startFromMe: false,
    endKey: end.key, endTimestamp: end.messageTimestamp, ...extra };
}
function fixture(options = {}) {
  let clock = SECONDS * 1000 + 100;
  const buffer = createRecentMessageBuffer({ groupIds: new Set([GROUP, OTHER]), now: () => clock, ...options });
  return { buffer, advance: ms => { clock += ms; } };
}
const ids = rows => rows?.map(row => row.key.id);

test('same-second range includes the verified anchor and excludes exact command and later rows', () => {
  const { buffer } = fixture();
  buffer.add(['before', 'anchor', 'middle', 'command', 'later'].map(id => message(id)));
  assert.deepEqual(ids(buffer.load(request())), ['anchor', 'middle']);
  assert.deepEqual(ids(buffer.load(request('anchor', message('later')))), ['anchor', 'middle', 'command']);
  assert.equal(buffer.load(request('unknown')), null);
  assert.equal(buffer.load(request('later')), null);
  assert.equal(buffer.load(request('anchor', message('missing-command'))), null);
});

test('range boundaries verify group, timestamp, direction and PN/LID sender aliases', () => {
  const { buffer } = fixture();
  buffer.add([message('anchor'), message('command')]);
  assert.deepEqual(ids(buffer.load(request('anchor', message('command'), { startParticipant: '456:99@lid' }))), ['anchor']);
  for (const extra of [{ startParticipant: '999@lid' }, { startParticipant: undefined }, { startFromMe: true },
    { endTimestamp: SECONDS + 1 }, { groupId: OTHER }]) assert.equal(buffer.load(request('anchor', message('command'), extra)), null);
  assert.equal(buffer.load(request('anchor', message('command', { key: { ...message('command').key, participant: '999@lid', participantAlt: undefined } }))), null);
  const own = message('own', { key: { remoteJid: GROUP, id: 'own', fromMe: true } });
  buffer.clear();
  buffer.add([own, message('command')]);
  assert.deepEqual(ids(buffer.load(request('own', message('command'), { startFromMe: true, startParticipant: undefined }))), ['own']);
});

test('projection drops raw payloads, quoted messages, media keys and all shared references', () => {
  const { buffer } = fixture();
  const secret = 'DO NOT RETAIN THIS';
  const raw = message('anchor', { message: { imageMessage: { caption: 'Visible caption', mediaKey: secret,
    url: secret, contextInfo: { quotedMessage: { conversation: secret }, mentionedJid: [secret] } } }, secret });
  buffer.add([raw, message('command')]);
  raw.message.imageMessage.caption = 'mutated original';
  const rows = buffer.load(request());
  assert.equal(JSON.stringify(rows).includes(secret), false);
  assert.equal(extractContent(rows[0]).text, 'Visible caption');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['key', 'message', 'messageTimestamp', 'pushName']);
  rows[0].message.imageMessage.caption = 'mutated result';
  rows[0].key.participant = '999@lid';
  assert.equal(extractContent(buffer.load(request())[0]).text, 'Visible caption');
  assert.equal(buffer.load(request())[0].key.participant, PERSON);
});

test('view-once, voice notes and unsupported media remain content-free placeholders', () => {
  const { buffer } = fixture();
  buffer.add([message('anchor', { message: { viewOnceMessage: { message: { imageMessage: { caption: 'hidden', mediaKey: 'secret' } } } } }),
    message('voice', { message: { audioMessage: { ptt: true, mediaKey: 'secret' } } }),
    message('unknown', { message: { contactMessage: { vcard: 'secret' } } }), message('command')]);
  const rows = normalizeMessages(buffer.load(request()), GROUP);
  assert.deepEqual(rows.map(row => [row.type, row.text]), [['viewOnce', ''], ['ptt', ''], ['unknown', '']]);
  assert.equal(JSON.stringify(buffer.load(request())).includes('secret'), false);
});

test('duplicates neither replace bodies nor renew message-based expiry', () => {
  const { buffer, advance } = fixture({ ttlMs: 1000 });
  buffer.add([message('anchor'), message('command')]);
  advance(500);
  buffer.add([message('anchor', { message: { conversation: 'replacement' } })]);
  assert.equal(extractContent(buffer.load(request())[0]).text, 'Text anchor');
  advance(400);
  assert.equal(buffer.load(request()), null);
});

test('expired or future input cannot create apparently complete coverage across a dropped row', () => {
  for (const timestamp of [SECONDS - 1, SECONDS + 301, NaN]) {
    const { buffer } = fixture({ ttlMs: 1000 });
    buffer.add([message('anchor'), message('bad', { messageTimestamp: timestamp }), message('command')]);
    assert.equal(buffer.load(request()), null);
  }
  const { buffer, advance } = fixture({ ttlMs: 2000 });
  buffer.add([message('anchor')]);
  advance(1000);
  buffer.add([message('new', { messageTimestamp: SECONDS + 1 }), message('command', { messageTimestamp: SECONDS + 1 })]);
  advance(900);
  buffer.prune();
  assert.equal(buffer.load(request('anchor', message('command', { messageTimestamp: SECONDS + 1 }))), null);
  assert.deepEqual(ids(buffer.load(request('new', message('command', { messageTimestamp: SECONDS + 1 })))), ['new']);
});

test('small sender clock skew is allowed but cannot extend retention beyond receipt TTL', () => {
  const { buffer, advance } = fixture({ ttlMs: 1000 });
  const end = message('command', { messageTimestamp: SECONDS + 1 });
  buffer.add([message('anchor', { messageTimestamp: SECONDS + 1 }), end]);
  advance(999);
  assert.deepEqual(ids(buffer.load(request('anchor', end))), ['anchor']);
  advance(1);
  assert.equal(buffer.load(request('anchor', end)), null);
});

test('count eviction keeps a continuous suffix and cannot bridge the evicted anchor', () => {
  const { buffer } = fixture({ maxMessagesPerGroup: 3 });
  buffer.add(['anchor', 'next', 'middle', 'command'].map(id => message(id)));
  assert.equal(buffer.load(request()), null);
  assert.deepEqual(ids(buffer.load(request('next'))), ['next', 'middle']);
});

test('global byte eviction removes oldest receipt prefixes across groups', () => {
  const { buffer } = fixture({ maxBytes: 1700 });
  buffer.add(['anchor', 'middle', 'command'].map(id => message(id)));
  const otherAnchor = message('other-anchor', { key: { ...message('x').key, remoteJid: OTHER, id: 'other-anchor' }, message: { conversation: 'x'.repeat(700) } });
  const otherEnd = message('other-command', { key: { ...message('x').key, remoteJid: OTHER, id: 'other-command' } });
  buffer.add([otherAnchor, otherEnd]);
  assert.equal(buffer.load(request()), null);
  assert.deepEqual(ids(buffer.load(request('other-anchor', otherEnd))), ['other-anchor']);
});

test('oversize, invalid and out-of-order rows invalidate only their allowed group', () => {
  for (const bad of [message('huge', { message: { conversation: 'x'.repeat(4000) } }),
    message('', { key: { ...message('x').key, id: '' } }), message('late', { messageTimestamp: SECONDS - 1 })]) {
    const { buffer } = fixture({ maxBytes: 2000 });
    buffer.add([message('anchor'), bad, message('command')]);
    assert.equal(buffer.load(request()), null);
  }
  const { buffer } = fixture({ groupIds: [GROUP] });
  buffer.add([message('anchor'), message('bad', { key: { remoteJid: OTHER } }), message('command')]);
  assert.deepEqual(ids(buffer.load(request())), ['anchor']);
});

test('revokes and edits scrub retained text without resetting range position or allowing resurrection', () => {
  const { buffer, advance } = fixture({ ttlMs: 1000 });
  buffer.add([message('anchor'), message('middle'), message('command')]);
  buffer.add([message('revoke', { message: { protocolMessage: { type: 0, key: message('anchor').key } } })]);
  buffer.invalidate([message('middle').key]);
  buffer.add([message('anchor'), message('middle')]);
  const rows = buffer.load(request());
  assert.deepEqual(ids(rows), ['anchor', 'middle']);
  assert.deepEqual(rows.map(row => [extractContent(row).text, extractContent(row).deleted]), [['', true], ['', true]]);
  assert.equal(JSON.stringify(rows).includes('Text anchor'), false);
  advance(900);
  assert.equal(buffer.load(request()), null);
});

test('invalidation ignores unknown keys and clears uncertain sender coverage; clear removes all coverage', () => {
  const { buffer } = fixture();
  buffer.add([message('anchor'), message('command')]);
  buffer.invalidate([message('unknown').key]);
  assert.equal(extractContent(buffer.load(request())[0]).text, 'Text anchor');
  buffer.invalidate([{ ...message('anchor').key, participant: 'wrong@lid', participantAlt: undefined }]);
  assert.equal(buffer.load(request()), null);
  buffer.add([message('anchor'), message('command')]);
  buffer.discardGroup(OTHER);
  assert.deepEqual(ids(buffer.load(request())), ['anchor']);
  buffer.discardGroup(GROUP);
  assert.equal(buffer.load(request()), null);
  buffer.add([message('anchor'), message('command')]);
  buffer.clear();
  assert.equal(buffer.load(request()), null);
});

test('revoked upsert stubs scrub an existing message and invalidation obeys the byte cap', () => {
  const initial = fixture().buffer;
  initial.add([message('anchor', { message: {} }), message('command')]);
  const rowSize = row => Buffer.byteLength(JSON.stringify(row)) + 128;
  const anchor = initial.load(request())[0];
  const command = { ...anchor, key: { ...anchor.key, id: 'command' }, message: { conversation: 'Text command' } };
  const { buffer } = fixture({ maxBytes: rowSize(anchor) + rowSize(command) });
  buffer.add([message('anchor', { message: {} }), message('command')]);
  assert.deepEqual(ids(buffer.load(request())), ['anchor']);
  buffer.invalidate([message('anchor').key]);
  assert.equal(buffer.load(request()), null, 'adding a tombstone field must still respect the byte budget');
  initial.add([message('anchor', { messageStubType: 1, message: null })]);
  assert.equal(extractContent(initial.load(request())[0]).deleted, true);
});

test('invalid configuration fails before retaining messages', () => {
  for (const options of [{ groupIds: ['not-a-group'] }, { groupIds: [] , ttlMs: 0 },
    { groupIds: [], maxMessagesPerGroup: -1 }, { groupIds: [], maxBytes: 0 }]) {
    assert.throws(() => createRecentMessageBuffer(options), TypeError);
  }
});
