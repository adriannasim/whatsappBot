import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJid, sameUser, messageTimestamp, extractContent, getIncomingCommand, normalizeMessages } from '../src/adapter.js';
import { createGreeting, getGreetingKind } from '../src/greetings.js';
import { FLIRTY_PHRASES } from '../src/flirty-phrases.js';

const group = '123456-789@g.us';
const ownIds = ['999:4@s.whatsapp.net', '111:2@lid'];
const message = (id = 'message-one', extra = {}) => ({
  key: { remoteJid: group, participant: '123:7@s.whatsapp.net', id, fromMe: false },
  messageTimestamp: 1_800_000_000,
  message: { conversation: 'Meet at six.' },
  ...extra,
});
function command(context = {}, extra = {}) {
  return message('command', {
    message: { extendedTextMessage: { text: '@SummaryBot !summarise', contextInfo: {
      stanzaId: 'anchor', participant: '123@s.whatsapp.net', mentionedJid: ['111@lid'], ...context,
    } } },
    ...extra,
  });
}

test('normalizes device JIDs while keeping PN/LID identities distinct', () => {
  assert.equal(normalizeJid('123:8@s.whatsapp.net'), '123@s.whatsapp.net');
  assert.equal(normalizeJid('123_1:8@lid'), '123@lid');
  assert.equal(normalizeJid('123@c.us'), '123@s.whatsapp.net');
  assert.equal(sameUser('123:8@s.whatsapp.net', '123@s.whatsapp.net'), true);
  assert.equal(sameUser('123@s.whatsapp.net', '123@lid'), false);
  for (const value of [null, '', 'bad', 'a@b@c', '123 @lid', '123@unknown']) assert.equal(normalizeJid(value), '');
  assert.equal(sameUser('', ''), false);
});

test('accepts numeric, bigint and protobuf Long timestamps and rejects invalid values', () => {
  for (const timestamp of [123, '123', 123n, { toNumber: () => 123 }, { low: 123, high: 0, unsigned: true }]) {
    assert.equal(messageTimestamp({ messageTimestamp: timestamp }), 123);
  }
  for (const timestamp of [undefined, -1, 1.5, NaN, Infinity, 'unknown', {}, { toNumber: () => { throw new Error('bad'); } }]) {
    assert.equal(Number.isNaN(messageTimestamp({ messageTimestamp: timestamp })), true);
  }
});

test('requires actual mention metadata and preserves quoted message identity', () => {
  const parsed = getIncomingCommand(command(), ownIds);
  assert.equal(parsed.mentioned, true);
  assert.equal(parsed.quotedId, 'anchor');
  assert.equal(parsed.quotedParticipant, '123@s.whatsapp.net');
  assert.equal(parsed.command.id, 'command');
  assert.equal(parsed.command.groupId, group);
  assert.equal(parsed.kind, 'summarise');
  assert.equal(getIncomingCommand(command({ mentionedJid: ['999:12@s.whatsapp.net'] }), ownIds).mentioned, true);
  assert.equal(getIncomingCommand(command({ mentionedJid: [] }), ownIds).mentioned, false);
  assert.equal(getIncomingCommand(command({ mentionedJid: ['someone@lid'] }), ownIds).mentioned, false);
  assert.equal(getIncomingCommand(command({ stanzaId: undefined }), ownIds).quotedId, null);
  assert.equal(getIncomingCommand(command({ remoteJid: 'another@g.us' }), ownIds).quotedId, null);
});

test('ignores direct chats, bot messages, invalid commands and protocol/edit payloads', () => {
  assert.equal(getIncomingCommand(message(), ownIds), null);
  assert.equal(getIncomingCommand(command({}, { key: { remoteJid: '123@s.whatsapp.net', id: 'direct' } }), ownIds), null);
  assert.equal(getIncomingCommand(command({}, { key: { remoteJid: group, id: 'self', fromMe: true } }), ownIds), null);
  assert.equal(getIncomingCommand(command({}, { key: { remoteJid: group, id: 'self', participant: '111:8@lid' } }), ownIds), null);
  assert.equal(getIncomingCommand(command({}, { key: { remoteJid: group, id: 'self', participant: '555@lid', participantAlt: '999@s.whatsapp.net' } }), ownIds), null);
  assert.equal(getIncomingCommand(command({}, { messageTimestamp: undefined }), ownIds), null);
  assert.equal(getIncomingCommand(command({}, { message: { protocolMessage: { type: 14, editedMessage: command().message } } }), ownIds), null);
  assert.equal(getIncomingCommand(command({}, { message: { editedMessage: { message: command().message } } }), ownIds), null);
  assert.equal(getIncomingCommand(command({}, { message: { protocolMessage: { type: 0 }, conversation: '!summarise' } }), ownIds), null);
});

test('unwraps ephemeral and document-caption messages without treating quoted text as commands', () => {
  const ephemeral = { ephemeralMessage: { message: command().message } };
  assert.equal(getIncomingCommand(command({}, { message: ephemeral }), ownIds).mentioned, true);
  assert.equal(extractContent({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'Agenda' } } } }).text, 'Agenda');
  const ordinary = message('ordinary', { message: { extendedTextMessage: {
    text: 'Thanks', contextInfo: { quotedMessage: command().message, stanzaId: 'old-command' },
  } } });
  assert.equal(getIncomingCommand(ordinary, ownIds), null);
});

test('copies supported text/captions only and does not expose media or view-once contents', () => {
  for (const [key, type] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['documentMessage', 'document']]) {
    const content = extractContent({ [key]: { caption: 'Dinner', jpegThumbnail: new Uint8Array([1]), url: 'private-media-url' } });
    assert.equal(content.text, 'Dinner');
    assert.equal(content.type, type);
    assert.equal(JSON.stringify(content).includes('private-media-url'), false);
  }
  for (const content of [
    { audioMessage: { ptt: true, caption: 'opaque' } },
    { viewOnceMessageV2: { message: { imageMessage: { caption: 'Private once' } } } },
    { viewOnceMessage: { message: { videoMessage: { caption: 'Private once' } } } },
  ]) assert.equal(extractContent(content).text, '');
  assert.equal(extractContent({ protocolMessage: { type: 0 } }).deleted, true);
  assert.equal(extractContent({ messageStubType: 1 }).deleted, true);
  let deep = { conversation: 'Too deep' };
  for (let i = 0; i < 10; i++) deep = { ephemeralMessage: { message: deep } };
  assert.equal(extractContent(deep).text, '');
});

test('labels participants consistently across PN/LID aliases without falling back to phone numbers', () => {
  const rows = normalizeMessages([
    message('a'),
    message('b', { key: { remoteJid: group, id: 'b', participant: '456@lid', participantAlt: '123@s.whatsapp.net' } }),
    message('c', { key: { remoteJid: group, id: 'c', participant: '456:8@lid' }, pushName: 'Alice' }),
    message('d', { key: { remoteJid: group, id: 'd', participant: '888@s.whatsapp.net' } }),
    message('e', { key: { remoteJid: group, id: 'e', participant: '999@s.whatsapp.net' } }),
  ], group, { ownIds });
  assert.deepEqual(rows.map(row => row.sender), ['Alice', 'Alice', 'Alice', 'Participant 2', 'Bot']);
  assert.equal(rows[4].fromBot, true);
  assert.ok(rows.every(row => !('person' in row) && !('participant' in row)));
  assert.equal(JSON.stringify(rows).includes('888@s.whatsapp.net'), false);
});

test('metadata names are available as a fallback but message names take priority', () => {
  const participants = [{ id: '456@lid', phoneNumber: '123@s.whatsapp.net', name: 'Contact Name' }];
  const rows = normalizeMessages([message('a'), message('b', { pushName: 'Alice\nExample' })], group, { participants });
  assert.deepEqual(rows.map(row => row.sender), ['Alice Example', 'Alice Example']);
  assert.equal(normalizeMessages([message('a', { verifiedBizName: 'Company' })], group, { participants })[0].sender, 'Company');
});

test('a later PN/LID alias unifies earlier labels for that participant', () => {
  const rows = normalizeMessages([
    message('pn', { pushName: 'Alice' }),
    message('lid', { key: { remoteJid: group, id: 'lid', participant: '456@lid' } }),
    message('bridge', { key: { remoteJid: group, id: 'bridge', participant: '456@lid', participantAlt: '123@s.whatsapp.net' } }),
  ], group);
  assert.deepEqual(rows.map(row => row.sender), ['Alice', 'Alice', 'Alice']);
});

test('normalization snapshots messages, filters unrelated/malformed rows, and marks summary commands', () => {
  const raw = [message('a'), command(), message('removed', { message: { protocolMessage: { type: 0 } } }),
    message('other', { key: { remoteJid: '999@g.us', id: 'other' } }), message('bad-time', { messageTimestamp: 'bad' }), null];
  const rows = normalizeMessages(raw, group, { ownIds });
  raw[0].message.conversation = 'Changed later';
  assert.equal(rows.length, 3);
  assert.equal(rows[0].text, 'Meet at six.');
  assert.equal(rows[1].isCommand, true);
  assert.equal(rows[2].deleted, true);
  assert.throws(() => normalizeMessages(null, group), /array/);
});

test('recognizes standalone greeting tokens without matching prefixes or conflicting greetings', () => {
  for (const text of ['!gm', '  !GM\n', 'Hello !gm everyone', '!gm !gm']) {
    assert.equal(getGreetingKind(text), 'gm');
  }
  for (const text of ['!gn', '\t!GN ', 'Time to rest !gn']) assert.equal(getGreetingKind(text), 'gn');
  for (const text of ['!horny', '  !HORNY\n', '!horny !horny']) assert.equal(getGreetingKind(text), 'horny');
  for (const text of [null, 1, '', 'gm', '!gmatch', '!gname', 'hello!gm', '!gm!', '!gn.', '!gm !gn', '!GN !GM',
    'horny', '!hornyness', 'hello!horny', '!horny!', '!horny !gm', '!gn !horny']) {
    assert.equal(getGreetingKind(text), null);
  }
});

test('greetings need no bot mention or quoted message and target the actual normalized sender', () => {
  for (const kind of ['gm', 'gn', 'horny']) {
    const parsed = getIncomingCommand(message(kind, { message: { conversation: `!${kind}` } }), ownIds);
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.senderJid, '123@s.whatsapp.net');
    assert.equal(parsed.mentioned, false);
    assert.equal(parsed.quotedId, null);
  }
  const lid = getIncomingCommand(message('lid-greeting', {
    key: { remoteJid: group, id: 'lid-greeting', participant: '456_1:4@lid', participantAlt: '123:8@s.whatsapp.net' },
    message: { extendedTextMessage: { text: '@999 !gm', contextInfo: {
      participant: '777@s.whatsapp.net', mentionedJid: ['999@s.whatsapp.net'], stanzaId: 'unrelated',
    } } },
  }), ownIds);
  assert.equal(lid.senderJid, '456@lid');
  assert.equal(lid.kind, 'gm');
  const alias = getIncomingCommand(message('alias', {
    key: { remoteJid: group, id: 'alias', participant: 'not-a-person@lid', participantAlt: '123:8@s.whatsapp.net' },
    message: { conversation: '!gn' },
  }), ownIds);
  assert.equal(alias.senderJid, '123@s.whatsapp.net');
  const rawParticipant = getIncomingCommand(message('raw-participant', {
    key: { remoteJid: group, id: 'raw-participant' }, participant: '456:2@lid', message: { conversation: '!gm' },
  }), ownIds);
  assert.equal(rawParticipant.senderJid, '456@lid');
});

test('greetings reject missing senders, bot messages, direct chats and hidden or quoted command content', () => {
  const greeting = { conversation: '!gm' };
  for (const key of [
    { remoteJid: group, id: 'missing' },
    { remoteJid: group, id: 'invalid', participant: 'alice@lid' },
    { remoteJid: group, id: 'own', participant: '999:2@s.whatsapp.net' },
    { remoteJid: group, id: 'own-alias', participant: '123@lid', participantAlt: '999@s.whatsapp.net' },
    { remoteJid: group, id: 'from-me', participant: '123@s.whatsapp.net', fromMe: true },
    { remoteJid: '123@s.whatsapp.net', id: 'direct', participant: '123@s.whatsapp.net' },
  ]) assert.equal(getIncomingCommand(message('greeting', { key, message: greeting }), ownIds), null);
  const missingWithMention = message('missing', {
    key: { remoteJid: group, id: 'missing' },
    message: { extendedTextMessage: { text: '!gn', contextInfo: { participant: '123@s.whatsapp.net', mentionedJid: ['123@s.whatsapp.net'] } } },
  });
  assert.equal(getIncomingCommand(missingWithMention, ownIds), null);
  for (const content of [
    { protocolMessage: { type: 14, editedMessage: greeting } },
    { editedMessage: { message: greeting } },
    { viewOnceMessage: { message: greeting } },
    { extendedTextMessage: { text: 'Thank you', contextInfo: { quotedMessage: greeting } } },
  ]) assert.equal(getIncomingCommand(message('hidden', { message: content }), ownIds), null);
});

test('summary commands retain priority when a message also contains greetings', () => {
  const mixed = command({}, { message: { extendedTextMessage: {
    text: '!gm !summarise !gn', contextInfo: { mentionedJid: ['999@s.whatsapp.net'], stanzaId: 'anchor' },
  } } });
  const parsed = getIncomingCommand(mixed, ownIds);
  assert.equal(parsed.kind, 'summarise');
  assert.equal(parsed.mentioned, true);
  assert.equal(parsed.quotedId, 'anchor');
  assert.equal(parsed.senderJid, undefined);
});

test('greeting replies mention only the supplied verified sender and contain a short encouraging phrase', () => {
  for (const [kind, salutation] of [['gm', 'Good morning'], ['gn', 'Good night']]) {
    for (const jid of ['123@s.whatsapp.net', '456@lid']) {
      const reply = createGreeting(kind, jid);
      const user = jid.split('@')[0];
      assert.deepEqual(reply.mentions, [jid]);
      assert.ok(reply.text.startsWith(`${salutation} @${user}!\n\n`));
      assert.ok(reply.text.length > salutation.length + user.length + 20);
      assert.ok(reply.text.length < 300);
      assert.equal((reply.text.match(/@/g) || []).length, 1);
    }
  }
  for (const jid of [undefined, '123:4@s.whatsapp.net', '123@g.us', 'alice@lid', '123@lid\n']) {
    assert.throws(() => createGreeting('gm', jid), /normalized participant/);
  }
  assert.throws(() => createGreeting('summarise', '123@lid'), /Unknown greeting/);
});

test('normalization marks greeting and flirty commands for transcript filtering', () => {
  const rows = normalizeMessages([
    message('gm', { message: { conversation: '!gm' } }),
    message('gn', { message: { conversation: 'Bye !GN' } }),
    message('horny', { message: { conversation: '!HORNY' } }),
    message('ordinary'),
    message('false-prefix', { message: { conversation: '!gmatch' } }),
  ], group, { ownIds });
  assert.deepEqual(rows.map(row => row.isCommand), [true, true, true, false, false]);
});

test('flirty replies draw from twenty distinct lines with emojis and mention only the sender', () => {
  assert.equal(FLIRTY_PHRASES.length, 20);
  assert.equal(new Set(FLIRTY_PHRASES.map(phrase => phrase.text)).size, 20);
  for (const phrase of FLIRTY_PHRASES) {
    assert.match(phrase.text, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(phrase.nickname + phrase.text, /@/);
  }
  for (const jid of ['123@s.whatsapp.net', '456@lid']) {
    const reply = createGreeting('horny', jid);
    assert.deepEqual(reply.mentions, [jid]);
    assert.ok(FLIRTY_PHRASES.some(phrase => reply.text === `Hey there, ${phrase.nickname} @${jid.split('@')[0]}!\n\n${phrase.text}`));
  }
});
