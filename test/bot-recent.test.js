import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppBot } from '../src/bot.js';
import { HistoryUnavailableError } from '../src/history-error.js';

const GROUP = '123456-789@g.us';
const OTHER = '222222-333@g.us';
const SECOND = 1_793_282_400;
const OWN = '999@s.whatsapp.net';
const SENDER = '111@lid';
function row(id, text = id, extra = {}) {
  return {
    key: { remoteJid: GROUP, id, participant: SENDER, participantAlt: '123@s.whatsapp.net', fromMe: false },
    messageTimestamp: SECOND, pushName: 'Alice', message: { conversation: text }, ...extra,
  };
}
function command(id = 'command', start = 'anchor', participant = SENDER) {
  return row(id, '', { message: { extendedTextMessage: {
    text: '@Bot !summarise',
    contextInfo: { stanzaId: start, participant, mentionedJid: [OWN] },
  } } });
}
function fixture(t, { maxMessages = 3000 } = {}) {
  let time = SECOND * 1000 + 1000;
  const calls = { history: [], ai: [], replies: [], diagnostics: [] };
  const makeSocket = () => ({
    async sendMessage(jid, content) {
      calls.replies.push(content.text);
      return { key: { remoteJid: jid, id: `sent-${calls.replies.length}`, fromMe: true }, message: { conversation: content.text } };
    },
  });
  let socket = makeSocket();
  const bot = createWhatsAppBot({
    config: { groupIds: new Set([GROUP]), maxMessages, historyTimeoutMs: 1000 },
    getSocket: () => socket, getOwnIds: () => [OWN], now: () => time,
    history: {
      async load(request) { calls.history.push(request); throw new HistoryUnavailableError('Phone history unavailable.'); },
      close() {},
    },
    async summarize(rows) { calls.ai.push(rows); return 'A concise summary.'; },
    onError: value => calls.diagnostics.push(value),
  });
  t.after(() => bot.close());
  return { bot, calls, advance(ms) { time += ms; }, replaceSocket() { socket = makeSocket(); } };
}

test('fresh live conversation summarises from RAM without a phone history request', async t => {
  const f = fixture(t);
  const first = row('anchor', 'I arrived home.');
  assert.deepEqual(await f.bot.handleMessages([first]), ['ignored']);
  first.message.conversation = 'Mutated externally';
  assert.deepEqual(await f.bot.handleMessages([row('dinner', 'Dinner was salad.'), command(), row('later', 'After the command.')]),
    ['ignored', 'summarised', 'ignored']);
  assert.equal(f.calls.history.length, 0);
  assert.deepEqual(f.calls.ai[0].map(r => [r.id, r.text, r.sender]), [
    ['anchor', 'I arrived home.', 'Alice'], ['dinner', 'Dinner was salad.', 'Alice'],
  ]);
  assert.match(f.calls.replies[0], /Summary of 2 available messages/);
  assert.equal(f.calls.diagnostics[0], 'History diagnostic: {"reason":"recent_buffer","retained":2}');
  assert.equal(await f.bot.getMessage(first.key), undefined);
});

test('records one whole batch before command handling and excludes bot, commands, view-once and other groups', async t => {
  const f = fixture(t);
  const rows = [
    row('anchor'),
    row('caption', '', { message: { imageMessage: { caption: 'The caption', mediaKey: Buffer.from('private') } } }),
    row('bot', 'Bot text', { key: { remoteJid: GROUP, id: 'bot', participant: OWN, fromMe: true } }),
    row('voice', '', { message: { audioMessage: { ptt: true } } }),
    row('private', '', { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'Never include' } } } } }),
    row('outside', 'Other group', { key: { remoteJid: OTHER, id: 'outside', participant: SENDER, fromMe: false } }),
    command(), row('later'),
  ];
  await f.bot.handleMessages(rows);
  assert.equal(f.calls.history.length, 0);
  assert.deepEqual(f.calls.ai[0].map(r => r.id), ['anchor', 'caption']);
  assert.match(f.calls.replies[0], /Omitted 2 non-text messages/);
});

test('missing or mismatched anchor falls back and never summarises a partial buffer', async t => {
  for (const participant of [SENDER, '456@s.whatsapp.net']) {
    const f = fixture(t);
    await f.bot.handleMessages([row(participant === SENDER ? 'newer' : 'anchor')]);
    assert.deepEqual(await f.bot.handleMessages([command('command', 'anchor', participant)]), ['failed']);
    assert.equal(f.calls.history.length, 1);
    assert.equal(f.calls.ai.length, 0);
  }
});

test('disconnect and socket replacement clear old coverage and new traffic can start a fresh range', async t => {
  for (const change of ['disconnect', 'replacement']) {
    const f = fixture(t);
    await f.bot.handleMessages([row('anchor')]);
    if (change === 'disconnect') f.bot.clearRecentMessages();
    else f.replaceSocket();
    assert.deepEqual(await f.bot.handleMessages([command()]), ['failed']);
    assert.equal(f.calls.ai.length, 0);
    assert.equal(f.calls.history.length, 1);
    assert.deepEqual(await f.bot.handleMessages([row('fresh'), command('fresh-command', 'fresh')]), ['ignored', 'summarised']);
    assert.deepEqual(f.calls.ai[0].map(r => r.id), ['fresh']);
  }
});

test('expired messages and closed bot cannot supply buffered summaries', async t => {
  const f = fixture(t);
  await f.bot.handleMessages([row('anchor')]);
  f.advance(24 * 60 * 60 * 1000);
  const freshCommand = command();
  freshCommand.messageTimestamp += 24 * 60 * 60;
  assert.deepEqual(await f.bot.handleMessages([freshCommand]), ['failed']);
  assert.equal(f.calls.ai.length, 0);
  f.bot.close();
  assert.deepEqual(await f.bot.handleMessages([row('fresh'), command('closed', 'fresh')]), ['ignored', 'ignored']);
  assert.equal(f.calls.ai.length, 0);
});

test('changed or deleted text is removed from a buffered range', async t => {
  const f = fixture(t);
  const deleted = row('deleted', 'Must not appear');
  await f.bot.handleMessages([row('anchor'), deleted, row('kept')]);
  f.bot.invalidateMessages([deleted.key]);
  await f.bot.handleMessages([deleted]); // a replay cannot restore the old text
  assert.deepEqual(await f.bot.handleMessages([command()]), ['summarised']);
  assert.deepEqual(f.calls.ai[0].map(r => r.id), ['anchor', 'kept']);
});

test('deleting all chat messages clears only the requested allowed group', async t => {
  const f = fixture(t);
  await f.bot.handleMessages([row('anchor')]);
  f.bot.discardGroup(OTHER);
  f.bot.discardGroup(GROUP);
  assert.deepEqual(await f.bot.handleMessages([command()]), ['failed']);
  assert.equal(f.calls.ai.length, 0);
});

test('buffered range still respects the configured summary message limit', async t => {
  const f = fixture(t, { maxMessages: 1 });
  assert.deepEqual(await f.bot.handleMessages([row('anchor'), row('second'), command()]), ['ignored', 'ignored', 'failed']);
  assert.equal(f.calls.history.length, 0);
  assert.equal(f.calls.ai.length, 0);
  assert.match(f.calls.replies[0], /exceeds the message limit/);
});
