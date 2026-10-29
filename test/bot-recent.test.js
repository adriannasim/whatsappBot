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
function fixture(t, { maxMessages = 3000, recentStore, savedRecent, ownIds = [OWN], historyLoad } = {}) {
  let time = SECOND * 1000;
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
    getSocket: () => socket, getOwnIds: () => ownIds, now: () => time,
    recentStore, savedRecent,
    history: {
      async load(request) {
        calls.history.push(request);
        if (historyLoad) return historyLoad(request);
        throw new HistoryUnavailableError('Phone history unavailable.');
      },
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
  assert.match(f.calls.replies[0], /2 messages summarised/);
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
  assert.match(f.calls.replies[0], /2 non-text messages skipped/);
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

test('disconnect and socket replacement preserve messages but warn about unfilled gaps', async t => {
  for (const change of ['disconnect', 'replacement']) {
    const f = fixture(t);
    await f.bot.handleMessages([row('anchor')]);
    if (change === 'disconnect') f.bot.markDisconnected();
    else f.replaceSocket();
    const nextCommand = command();
    nextCommand.messageTimestamp += 1;
    assert.deepEqual(await f.bot.handleMessages([nextCommand]), ['summarised']);
    assert.deepEqual(f.calls.ai[0].map(r => r.id), ['anchor']);
    assert.match(f.calls.replies[0], /Some messages from an offline or recovery gap may be missing/);
    assert.equal(f.calls.history.length, 1);
    f.advance(30_000);
    const fresh = row('fresh', 'New range', { messageTimestamp: SECOND + 31 });
    const freshCommand = command('fresh-command', 'fresh');
    freshCommand.messageTimestamp += 31;
    assert.deepEqual(await f.bot.handleMessages([fresh, freshCommand]), ['ignored', 'summarised']);
    assert.deepEqual(f.calls.ai[1].map(r => r.id), ['fresh']);
    assert.doesNotMatch(f.calls.replies[1], /gap may be missing/);
  }
});

test('saved messages and missed deliveries survive restart without replaying old commands', async t => {
  let saved;
  const store = {
    async save(value) { saved = structuredClone(value); },
    async flush() {},
  };
  const first = fixture(t, { recentStore: store });
  await first.bot.handleMessages([row('anchor', 'Before restart'), command('old-command')]);
  await first.bot.close();
  await first.bot.flush();
  assert.equal(saved.owner, OWN);
  assert.ok(saved.buffer.entries.length >= 2);
  const next = fixture(t, { recentStore: store, savedRecent: saved });
  next.advance(60_000);
  next.bot.onConnected();
  next.bot.handleReplayMessages([
    row('missed', 'Delivered after reconnect', { messageTimestamp: SECOND + 30 }),
    command('old-command'),
  ]);
  assert.equal(next.calls.ai.length, 0);
  assert.equal(next.calls.replies.length, 0);
  assert.deepEqual(await next.bot.handleMessages([command('old-command')]), ['duplicate']);
  const fresh = row('fresh', 'After restart', { messageTimestamp: SECOND + 60 });
  const requested = command('new-command');
  requested.messageTimestamp += 60;
  assert.deepEqual(await next.bot.handleMessages([fresh, requested]), ['ignored', 'summarised']);
  assert.deepEqual(next.calls.ai[0].map(r => r.id), ['anchor', 'missed', 'fresh']);
  assert.match(next.calls.replies[0], /gap may be missing/);
  await next.bot.flush();
  assert.equal(saved.owner, OWN);
  assert.ok(saved.buffer.entries.some(entry => entry.row.key.id === 'missed'));
});

test('a saved cache belongs only to its linked account', async t => {
  let saved;
  const store = { async save(value) { saved = structuredClone(value); }, async flush() {} };
  const first = fixture(t, { recentStore: store });
  await first.bot.handleMessages([row('anchor', 'Private first account')]);
  await first.bot.close();
  const next = fixture(t, { recentStore: store, savedRecent: { ...saved, owner: '888@s.whatsapp.net' } });
  assert.deepEqual(await next.bot.handleMessages([command()]), ['failed']);
  assert.equal(next.calls.ai.length, 0);
  await next.bot.flush();
  assert.ok(!saved.buffer.entries.some(entry => entry.row.key.id === 'anchor'));
});

test('pending cache expires without a connection and waits for the phone-number identity', async t => {
  let saved;
  const store = { async save(value) { saved = structuredClone(value); }, async flush() {} };
  const first = fixture(t, { recentStore: store });
  await first.bot.handleMessages([row('anchor')]);
  await first.bot.close();
  const original = structuredClone(saved);
  const ownIds = ['888@lid'];
  const waiting = fixture(t, { recentStore: store, savedRecent: saved, ownIds });
  waiting.bot.onConnected();
  await waiting.bot.flush();
  assert.equal(saved.owner, OWN);
  assert.equal(saved.buffer.entries[0].row.key.id, 'anchor');
  waiting.advance(24 * 60 * 60 * 1000);
  await waiting.bot.flush();
  assert.deepEqual(saved.buffer.entries, []);
  await waiting.bot.close();

  const ids = ['888@lid'];
  const delayedIdentity = fixture(t, { recentStore: store, savedRecent: original, ownIds: ids });
  assert.deepEqual(await delayedIdentity.bot.handleMessages([command()]), ['ignored']);
  ids.push(OWN);
  assert.deepEqual(await delayedIdentity.bot.handleMessages([command()]), ['summarised']);
  assert.deepEqual(delayedIdentity.calls.ai[0].map(r => r.id), ['anchor']);
});

test('unknown commands from before the connection epoch do not execute', async t => {
  const f = fixture(t);
  f.advance(1000);
  f.bot.onConnected();
  assert.deepEqual(await f.bot.handleMessages([command('old-unseen')]), ['ignored']);
  assert.equal(f.calls.ai.length, 0);
  assert.equal(f.calls.history.length, 0);
  assert.equal(f.calls.replies.length, 0);
});

test('verified phone recovery supplies a complete range without a gap warning', async t => {
  const f = fixture(t, { historyLoad: async () => [row('anchor'), row('recovered', 'Recovered from phone')] });
  await f.bot.handleMessages([row('anchor')]);
  f.bot.markDisconnected();
  const requested = command();
  requested.messageTimestamp += 1;
  assert.deepEqual(await f.bot.handleMessages([requested]), ['summarised']);
  assert.equal(f.calls.history.length, 1);
  assert.deepEqual(f.calls.ai[0].map(r => r.id), ['anchor', 'recovered']);
  assert.doesNotMatch(f.calls.replies[0], /gap may be missing/);
});

test('cache write failures keep live summaries available and never expose file errors', async t => {
  const f = fixture(t, { recentStore: {
    async save() { throw new Error('secret path and message contents'); },
    async flush() { throw new Error('secret path and message contents'); },
  } });
  assert.deepEqual(await f.bot.handleMessages([row('anchor'), command()]), ['ignored', 'summarised']);
  await f.bot.flush();
  assert.ok(f.calls.diagnostics.some(value => /could not be saved/.test(value)));
  assert.doesNotMatch(f.calls.diagnostics.join('\n'), /secret path|message contents/);
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
