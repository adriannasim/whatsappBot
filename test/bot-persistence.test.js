import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createWhatsAppBot } from '../src/bot.js';
import { HistoryUnavailableError } from '../src/history-error.js';
import { openRecentMessageStore } from '../src/recent-store.js';

const GROUP = '123456-789@g.us';
const OWN_IDS = ['999:4@s.whatsapp.net', '111:2@lid'];
const SECONDS = 1_800_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GUIDANCE = 'WhatsApp history is unavailable. Reply to a newer starting message and try again.';

function message(id, timestamp, text = `Text ${id}`) {
  return {
    key: { remoteJid: GROUP, participant: '123:7@s.whatsapp.net', id, fromMe: false },
    messageTimestamp: timestamp,
    pushName: 'Alice',
    message: { conversation: text },
  };
}

function command(id, timestamp) {
  return {
    ...message(id, timestamp),
    message: { extendedTextMessage: {
      text: '@SummaryBot !summarise',
      contextInfo: {
        stanzaId: 'anchor', participant: '123@s.whatsapp.net', mentionedJid: ['111@lid'],
      },
    } },
  };
}

test('real private cache survives bot restart, includes replay with a gap warning, and never renews expired history', async t => {
  const parent = path.resolve(process.cwd());
  const root = await mkdtemp(path.join(parent, '.bot-persistence-test-'));
  const directory = path.join(root, 'private');
  const bots = [];
  t.after(async () => {
    await Promise.all(bots.map(bot => bot.close()));
    // Delete only the exact workspace fixture created by this test.
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('.bot-persistence-test-'));
    await rm(root, { recursive: true, force: true });
  });

  let clock = SECONDS * 1000;
  const warnings = [];
  async function restart() {
    const store = await openRecentMessageStore({ directory, onWarning: text => warnings.push(text) });
    const savedRecent = await store.load();
    const calls = { loads: [], inputs: [], sends: [], errors: [] };
    const socket = {
      async sendMessage(groupId, content, options) {
        calls.sends.push({ groupId, content, options });
        return {
          key: { remoteJid: groupId, id: `reply-${calls.sends.length}`, fromMe: true },
          message: { conversation: content.text },
        };
      },
    };
    const bot = createWhatsAppBot({
      config: { groupIds: new Set([GROUP]), maxMessages: 3000, historyTimeoutMs: 1000 },
      getSocket: () => socket,
      getOwnIds: () => OWN_IDS,
      history: {
        async load(request) {
          calls.loads.push(request);
          throw new HistoryUnavailableError(GUIDANCE);
        },
        close() {},
      },
      async summarize(rows) {
        calls.inputs.push(rows);
        return 'Saved plan summary.';
      },
      recentStore: store,
      savedRecent,
      onError: text => calls.errors.push(text),
      now: () => clock,
    });
    bots.push(bot);
    bot.onConnected();
    await bot.flush();
    return { bot, store, calls, savedRecent };
  }

  const anchor = message('anchor', SECONDS, 'Meet at six.');
  const first = await restart();
  assert.equal(first.savedRecent, null);
  assert.deepEqual(await first.bot.handleMessages([anchor]), ['ignored']);
  await first.bot.close();
  const firstSaved = await first.store.load();
  assert.equal(firstSaved.owner, '999@s.whatsapp.net');
  assert.deepEqual(firstSaved.buffer.entries.map(entry => entry.row.key.id), ['anchor']);
  const anchorExpiry = firstSaved.buffer.entries[0].expiresAt;
  assert.equal(anchorExpiry, SECONDS * 1000 + DAY_MS);

  clock += 60_000;
  const second = await restart();
  assert.deepEqual(second.savedRecent, firstSaved);
  const missed = message('missed', SECONDS + 30, 'Bring the notes.');
  second.bot.handleReplayMessages([command('offline-command', SECONDS + 40), missed, anchor]);
  await second.bot.flush();
  assert.equal(second.calls.loads.length, 0, 'offline replay must not fetch history for old commands');
  assert.equal(second.calls.inputs.length, 0, 'offline replay must not spend an AI request');
  assert.equal(second.calls.sends.length, 0, 'offline replay must not send a reply');
  assert.deepEqual(await second.bot.handleMessages([message('fresh', SECONDS + 60, 'I will be there.')]), ['ignored']);
  clock += 1000;
  const freshCommand = command('fresh-command', SECONDS + 61);
  assert.deepEqual(await second.bot.handleMessages([freshCommand]), ['summarised']);
  assert.equal(second.calls.loads.length, 1, 'the disconnected range must first attempt phone recovery');
  assert.deepEqual(second.calls.inputs.map(rows => rows.map(row => [row.id, row.text])), [[
    ['anchor', 'Meet at six.'], ['missed', 'Bring the notes.'], ['fresh', 'I will be there.'],
  ]]);
  assert.equal(second.calls.sends.length, 1);
  assert.match(second.calls.sends[0].content.text, /3 messages summarised/);
  assert.match(second.calls.sends[0].content.text, /Some messages from an offline or recovery gap may be missing\./);
  assert.match(second.calls.sends[0].content.text, /Saved plan summary\./);
  assert.equal(second.calls.sends[0].options.quoted, freshCommand);
  await second.bot.close();

  const third = await restart();
  const restoredEntries = third.savedRecent.buffer.entries;
  assert.deepEqual(new Set(restoredEntries.map(entry => entry.row.key.id)),
    new Set(['anchor', 'missed', 'offline-command', 'fresh', 'fresh-command']));
  assert.equal(restoredEntries.find(entry => entry.row.key.id === 'anchor').expiresAt, anchorExpiry);
  assert.deepEqual(await third.bot.handleMessages([freshCommand]), ['duplicate']);
  assert.equal(third.calls.inputs.length, 0, 'persisted command IDs must prevent execution after another restart');
  assert.equal(third.calls.sends.length, 0);
  await third.bot.close();

  clock = anchorExpiry + 1000;
  const expired = await restart();
  assert.equal(expired.savedRecent.buffer.entries.find(entry => entry.row.key.id === 'anchor').expiresAt, anchorExpiry);
  assert.equal((await expired.store.load()).buffer.entries.some(entry => entry.row.key.id === 'anchor'), false,
    'restore must prune the expired anchor from the next private snapshot');
  expired.bot.handleReplayMessages([anchor]);
  assert.deepEqual(await expired.bot.handleMessages([command('expired-anchor-command', Math.floor(clock / 1000))]), ['failed']);
  assert.equal(expired.calls.loads.length, 1);
  assert.equal(expired.calls.inputs.length, 0, 'an expired anchor cannot authorize a partial summary');
  assert.equal(expired.calls.sends[0].content.text, GUIDANCE);
  await expired.bot.close();
  const finalStore = await openRecentMessageStore({ directory });
  assert.equal((await finalStore.load()).buffer.entries.some(entry => entry.row.key.id === 'anchor'), false,
    'an expired replay must not resurrect the anchor or renew its retention');
  assert.deepEqual(await readdir(directory), ['cache.json']);
  assert.deepEqual(warnings, []);
});
