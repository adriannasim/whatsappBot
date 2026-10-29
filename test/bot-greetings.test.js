import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppBot } from '../src/bot.js';

const GROUP = '123456-789@g.us';
const OWN = '999@s.whatsapp.net';
const SECOND = 1_800_000_000;
function message(id, text, participant = '123:7@s.whatsapp.net') {
  return {
    key: { remoteJid: GROUP, id, participant, fromMe: false },
    messageTimestamp: SECOND, pushName: 'Alice', message: { conversation: text },
  };
}

function fixture(t, { recentStore, savedRecent } = {}) {
  const calls = { history: [], ai: [], sends: [], errors: [] };
  const socket = {
    async sendMessage(groupId, content, options) {
      calls.sends.push({ groupId, content, options });
      return { key: { remoteJid: groupId, id: `reply-${calls.sends.length}` }, message: { conversation: content.text } };
    },
  };
  const bot = createWhatsAppBot({
    config: { groupIds: new Set([GROUP]), maxMessages: 3000, historyTimeoutMs: 1000 },
    getSocket: () => socket, getOwnIds: () => [OWN], now: () => SECOND * 1000,
    history: { async load(request) { calls.history.push(request); throw new Error('No history expected'); }, close() {} },
    async summarize(rows) { calls.ai.push(rows); return 'Dinner is salad.'; },
    onError: error => calls.errors.push(error), recentStore, savedRecent,
  });
  t.after(() => bot.close());
  return { bot, calls };
}

test('morning and night greet the actual PN/LID sender without a mention, quote, history or AI', async t => {
  const f = fixture(t);
  const morning = message('morning', '!gm');
  const night = message('night', '!GN', '456:8@lid');
  assert.deepEqual(await f.bot.handleMessages([morning, night]), ['greeted', 'greeted']);
  assert.equal(f.calls.sends.length, 2);
  for (const [index, greeting, target, raw] of [[0, 'morning', '123@s.whatsapp.net', morning], [1, 'night', '456@lid', night]]) {
    const sent = f.calls.sends[index];
    assert.equal(sent.groupId, GROUP);
    assert.match(sent.content.text, new RegExp(`Good ${greeting}.*@${target.split('@')[0]}`, 'i'));
    assert.deepEqual(sent.content.mentions, [target]);
    assert.equal(sent.options.quoted, raw);
    assert.ok(sent.content.text.length > 45);
    assert.equal((await f.bot.getMessage({ remoteJid: GROUP, id: `reply-${index + 1}` })).conversation, sent.content.text);
  }
  assert.deepEqual(f.calls.history, []);
  assert.deepEqual(f.calls.ai, []);
  assert.deepEqual(f.calls.errors, []);
});

test('other groups, own messages, old commands and offline replay do not trigger greetings', async t => {
  const f = fixture(t);
  const wrongGroup = message('outside', '!gm');
  wrongGroup.key.remoteJid = '987@g.us';
  const own = message('self', '!gn', OWN);
  const old = { ...message('old', '!gm'), messageTimestamp: SECOND - 1 };
  assert.deepEqual(await f.bot.handleMessages([wrongGroup, own, old]), ['ignored', 'ignored', 'ignored']);
  const replay = message('replay', '!gn');
  f.bot.handleReplayMessages([replay]);
  assert.deepEqual(await f.bot.handleMessages([replay]), ['duplicate']);
  assert.deepEqual(f.calls.sends, []);
  assert.deepEqual(f.calls.ai, []);
});

test('duplicate greetings are suppressed in the same batch, on redelivery and after restoring the cache', async t => {
  let saved;
  const recentStore = { async save(value) { saved = structuredClone(value); }, async flush() {} };
  const f = fixture(t, { recentStore });
  const greeting = message('greeting', '!gm');
  assert.deepEqual(await f.bot.handleMessages([greeting, greeting]), ['greeted', 'duplicate']);
  assert.deepEqual(await f.bot.handleMessages([greeting]), ['duplicate']);
  assert.equal(f.calls.sends.length, 1);
  await f.bot.close();
  const restarted = fixture(t, { recentStore, savedRecent: saved });
  assert.deepEqual(await restarted.bot.handleMessages([greeting]), ['duplicate']);
  assert.deepEqual(restarted.calls.sends, []);
  assert.deepEqual(await restarted.bot.handleMessages([message('new-greeting', '!gn')]), ['greeted']);
});

test('greeting commands stay out of summaries and do not consume the summary cooldown', async t => {
  const f = fixture(t);
  const anchor = message('anchor', 'Dinner is salad.');
  const summary = message('summary', '');
  summary.message = { extendedTextMessage: { text: '@Bot !summarise', contextInfo: {
    mentionedJid: [OWN], stanzaId: 'anchor', participant: '123@s.whatsapp.net',
  } } };
  assert.deepEqual(await f.bot.handleMessages([anchor, message('gm', '!gm'), message('gn', '!gn'), summary]),
    ['ignored', 'greeted', 'greeted', 'summarised']);
  assert.equal(f.calls.ai.length, 1);
  assert.deepEqual(f.calls.ai[0].map(row => row.id), ['anchor']);
  assert.equal(f.calls.history.length, 0);
});
