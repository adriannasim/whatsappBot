import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWhatsAppBot } from '../src/bot.js';
import { HistoryUnavailableError } from '../src/history-error.js';

const GROUP = '123456-789@g.us';
const OTHER_GROUP = '987654-321@g.us';
const OWN_IDS = ['999:4@s.whatsapp.net', '111:2@lid'];
const TIMESTAMP = 1_800_000_000;

function message(id, extra = {}) {
  return {
    key: { remoteJid: GROUP, participant: '123:7@s.whatsapp.net', id, fromMe: false },
    messageTimestamp: TIMESTAMP,
    pushName: 'Alice',
    message: { conversation: 'Meet at six.' },
    ...extra,
  };
}

function command(id = 'command', context = {}, extra = {}) {
  return message(id, {
    messageTimestamp: TIMESTAMP + 60,
    message: {
      extendedTextMessage: {
        text: '@SummaryBot !summarise',
        contextInfo: {
          stanzaId: 'anchor', participant: '123@s.whatsapp.net',
          mentionedJid: ['111@lid'], ...context,
        },
      },
    },
    ...extra,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, options = {}) {
  const calls = { loads: [], inputs: [], sends: [], errors: [], closes: 0 };
  let clock = 1000;
  let sentCount = 0;
  const makeSocket = (label = 'initial') => ({
    sendMessage: async (groupId, content, sendOptions) => {
      calls.sends.push({ label, groupId, content, options: sendOptions });
      return {
        key: { remoteJid: groupId, id: options.sentId ?? `out-${++sentCount}`, fromMe: true },
        message: { conversation: content.text },
      };
    },
  });
  let socket = makeSocket();
  const bot = createWhatsAppBot({
    config: { groupIds: new Set(options.groupIds ?? [GROUP]), maxMessages: 3000, historyTimeoutMs: 1000 },
    getSocket: () => socket,
    getOwnIds: () => OWN_IDS,
    history: {
      load: async request => {
        calls.loads.push(request);
        if (options.load) return options.load(request);
        return options.rows ?? [message('anchor', {
          key: { remoteJid: request.groupId, id: 'anchor', participant: '123@s.whatsapp.net', fromMe: false },
        })];
      },
      close: () => { calls.closes++; },
    },
    summarize: async rows => {
      calls.inputs.push(rows);
      return options.summarize ? options.summarize(rows) : 'Plan agreed: meet at six.';
    },
    onError: error => { calls.errors.push(error); },
    now: () => clock,
  });
  t.after(() => bot.close());
  return {
    bot, calls,
    advance: ms => { clock += ms; },
    reconnect: () => { socket = makeSocket('replacement'); },
    disconnect: () => { socket = null; },
  };
}

test('ordinary messages, typed mentions, other groups, and bot messages do not fetch history or call AI', async t => {
  const f = fixture(t);
  const ownKey = { remoteJid: GROUP, id: 'own-command', participant: '999:8@s.whatsapp.net', fromMe: false };
  const samples = [
    message('ordinary'),
    command('typed-mention', { mentionedJid: [] }),
    command('wrong-mention', { mentionedJid: ['444@lid'] }),
    command('wrong-group', {}, { key: { remoteJid: OTHER_GROUP, id: 'wrong-group', participant: '123@s.whatsapp.net' } }),
    command('own-command', {}, { key: ownKey }),
    command('from-me', {}, { key: { ...ownKey, id: 'from-me', fromMe: true, participant: '123@s.whatsapp.net' } }),
  ];
  assert.deepEqual(await f.bot.handleMessages(samples), samples.map(() => 'ignored'));
  assert.deepEqual(await f.bot.handleMessages(undefined), []);
  assert.equal(f.calls.loads.length, 0);
  assert.equal(f.calls.inputs.length, 0);
  assert.equal(f.calls.sends.length, 0);
  for (const raw of samples) assert.equal(await f.bot.getMessage(raw.key), undefined);
});

test('real PN and LID mentions with device suffixes work in allowed groups', async t => {
  const f = fixture(t, { groupIds: [GROUP, OTHER_GROUP] });
  const phoneCommand = command('phone-command', { mentionedJid: ['999:10@s.whatsapp.net'] });
  const lidCommand = command('lid-command', { mentionedJid: ['111:7@lid'] }, {
    key: { remoteJid: OTHER_GROUP, id: 'lid-command', participant: '555@lid', fromMe: false },
  });
  assert.deepEqual(await f.bot.handleMessages([phoneCommand, lidCommand]), ['summarised', 'summarised']);
  assert.deepEqual(f.calls.loads.map(request => request.groupId).sort(), [GROUP, OTHER_GROUP].sort());
  assert.equal(f.calls.inputs.length, 2);
  assert.equal(f.calls.sends.length, 2);
});

test('passes the exact command cursor and includes the anchor while filtering unsupported content', async t => {
  const incoming = command('command', { participant: '123:9@s.whatsapp.net' }, {
    key: { remoteJid: GROUP, id: 'command', participant: '234:7@lid', participantAlt: '456@s.whatsapp.net', fromMe: false },
    messageTimestamp: { toNumber: () => TIMESTAMP + 60 },
  });
  const rows = [
    message('anchor', { message: { conversation: '  Meet at six.  ' } }),
    message('caption', { message: { imageMessage: { caption: '  Bring the tickets.  ' } } }),
    message('voice', { message: { audioMessage: { ptt: true } } }),
    message('view-once', { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'Private caption' } } } } }),
    message('deleted', { messageStubType: 1, message: { conversation: 'Removed text' } }),
    message('bot-reply', { key: { remoteJid: GROUP, id: 'bot-reply', participant: '111:6@lid', fromMe: false } }),
    command('previous-command'),
    message('other-group', { key: { remoteJid: OTHER_GROUP, id: 'other-group', participant: '333@s.whatsapp.net' } }),
    incoming,
  ];
  const f = fixture(t, { rows });
  assert.deepEqual(await f.bot.handleMessages([incoming]), ['summarised']);
  assert.deepEqual(f.calls.loads, [{
    groupId: GROUP, startId: 'anchor', startParticipant: '123@s.whatsapp.net', startFromMe: false,
    endKey: incoming.key, endTimestamp: TIMESTAMP + 60,
  }]);
  assert.notEqual(f.calls.loads[0].endKey, incoming.key);
  assert.deepEqual(f.calls.inputs[0].map(row => [row.id, row.text, row.sender]), [
    ['anchor', 'Meet at six.', 'Alice'], ['caption', 'Bring the tickets.', 'Alice'],
  ]);
  const reply = f.calls.sends[0];
  assert.equal(reply.groupId, GROUP);
  assert.equal(reply.options.quoted, incoming);
  assert.deepEqual(reply.content.mentions, []);
  assert.equal(reply.content.linkPreview, null);
  assert.match(reply.content.text, /2 messages summarised/);
  assert.match(reply.content.text, /2 non-text messages skipped/);
  assert.match(reply.content.text, /15 Jan 2027 · 4:00–4:01 pm MYT/);
});

test('a missing or cross-group quote requests a starting message without loading history', async t => {
  const f = fixture(t);
  const missing = command('missing-quote', { stanzaId: undefined });
  const crossGroup = command('cross-group-quote', { remoteJid: OTHER_GROUP });
  assert.deepEqual(await f.bot.handleMessages([missing]), ['missing-quote']);
  assert.deepEqual(await f.bot.handleMessages([crossGroup]), ['missing-quote']);
  assert.equal(f.calls.loads.length, 0);
  assert.equal(f.calls.inputs.length, 0);
  assert.equal(f.calls.sends.length, 2);
  assert.match(f.calls.sends[0].content.text, /Reply to the first message/);
});

test('retry lookup only retains outgoing replies, isolates groups, and expires at five minutes', async t => {
  const f = fixture(t, { groupIds: [GROUP, OTHER_GROUP], sentId: 'shared-outgoing-id' });
  const first = command('first-command', { stanzaId: undefined });
  const second = command('second-command', { stanzaId: undefined }, {
    key: { remoteJid: OTHER_GROUP, id: 'second-command', participant: '123@s.whatsapp.net', fromMe: false },
  });
  await f.bot.handleMessages([first]);
  const firstReply = await f.bot.getMessage({ remoteJid: GROUP, id: 'shared-outgoing-id' });
  assert.equal(firstReply.conversation, f.calls.sends[0].content.text);
  assert.equal(await f.bot.getMessage({ remoteJid: OTHER_GROUP, id: 'shared-outgoing-id' }), undefined);
  assert.equal(await f.bot.getMessage(first.key), undefined);
  assert.equal(await f.bot.getMessage({ remoteJid: GROUP, id: 'anchor' }), undefined);
  f.advance(1000);
  await f.bot.handleMessages([second]);
  const secondReply = await f.bot.getMessage({ remoteJid: OTHER_GROUP, id: 'shared-outgoing-id' });
  assert.ok(secondReply);
  assert.notEqual(firstReply, secondReply);
  f.advance(299_000);
  assert.equal(await f.bot.getMessage({ remoteJid: GROUP, id: 'shared-outgoing-id' }), undefined);
  assert.equal(await f.bot.getMessage({ remoteJid: OTHER_GROUP, id: 'shared-outgoing-id' }), secondReply);
  f.advance(1000);
  assert.equal(await f.bot.getMessage({ remoteJid: OTHER_GROUP, id: 'shared-outgoing-id' }), undefined);
});

test('retry cache evicts the oldest outgoing reply once fifty are retained', async t => {
  const f = fixture(t);
  for (let index = 0; index < 51; index++) {
    assert.deepEqual(await f.bot.handleMessages([command(`command-${index}`, { stanzaId: undefined })]), ['missing-quote']);
  }
  assert.equal(await f.bot.getMessage({ remoteJid: GROUP, id: 'out-1' }), undefined);
  assert.ok(await f.bot.getMessage({ remoteJid: GROUP, id: 'out-2' }));
  assert.ok(await f.bot.getMessage({ remoteJid: GROUP, id: 'out-51' }));
  assert.equal(f.calls.loads.length, 0);
  assert.equal(f.calls.inputs.length, 0);
});

test('a failed history request gives recovery guidance without inferring a summary or exposing errors', async t => {
  const f = fixture(t, {
    load: async () => { throw Object.assign(new Error('private request token and phone number'), { code: 'HISTORY_UNAVAILABLE' }); },
  });
  assert.deepEqual(await f.bot.handleMessages([command()]), ['failed']);
  assert.equal(f.calls.inputs.length, 0);
  assert.equal(f.calls.sends.length, 1);
  assert.match(f.calls.sends[0].content.text, /could not retrieve.*requested range/);
  assert.match(f.calls.sends[0].content.text, /phone online/);
  assert.doesNotMatch(f.calls.sends[0].content.text, /private request|token|phone number/);
  assert.deepEqual(f.calls.errors, ['History retrieval failed: WhatsApp history is unavailable.']);
});

test('reports the specific application-authored history failure in chat and owner logs', async t => {
  const guidance = 'WhatsApp disconnected while loading history. Please try again after it reconnects.';
  const f = fixture(t, {
    load: async () => { throw new HistoryUnavailableError(guidance); },
  });
  assert.deepEqual(await f.bot.handleMessages([command()]), ['failed']);
  assert.equal(f.calls.inputs.length, 0);
  assert.equal(f.calls.sends[0].content.text, guidance);
  assert.deepEqual(f.calls.errors, [`History retrieval failed: ${guidance}`]);
});

for (const loggingThrows of [false, true]) {
  test(`default history reports an empty page and preserves recovery when logging ${loggingThrows ? 'throws' : 'succeeds'}`, async t => {
    const errors = [];
    const replies = [];
    let summaries = 0;
    let fetches = 0;
    const ev = new EventEmitter();
    const socket = {
      ev,
      async fetchMessageHistory() {
        const session = `history-request-${++fetches}`;
        ev.emit('messaging-history.set', {
          syncType: 6, peerDataRequestSessionId: session, messages: [], progress: 100,
        });
        return session;
      },
      async sendMessage(groupId, content) {
        replies.push(content.text);
        return { key: { remoteJid: groupId, id: 'recovery-reply' }, message: { conversation: content.text } };
      },
    };
    const bot = createWhatsAppBot({
      config: { groupIds: new Set([GROUP]), maxMessages: 3000, historyTimeoutMs: 6000 },
      getSocket: () => socket,
      getOwnIds: () => OWN_IDS,
      summarize: async () => { summaries++; return 'Unexpected summary'; },
      onError: error => {
        errors.push(error);
        if (loggingThrows) throw new Error('Logging is unavailable');
      },
    });
    t.after(() => bot.close());

    assert.deepEqual(await bot.handleMessages([command()]), ['failed']);
    const diagnostics = errors.filter(error => error.startsWith('History diagnostic: '));
    assert.equal(diagnostics.length, 2);
    const retryDiagnostic = JSON.parse(diagnostics[0].slice('History diagnostic: '.length));
    assert.equal(retryDiagnostic.reason, 'empty_page_retry');
    const diagnostic = JSON.parse(diagnostics[1].slice('History diagnostic: '.length));
    assert.equal(diagnostic.reason, 'empty_page');
    assert.equal(diagnostic.pages, 2);
    assert.equal(diagnostic.retries, 1);
    assert.equal(diagnostic.pageRows, 0);
    assert.equal(fetches, 2);
    assert.equal(summaries, 0);
    assert.deepEqual(replies, ['WhatsApp returned no earlier messages. Reply to a newer message sent while the bot is connected, mention the bot, and send !summarise.']);
    assert.equal(errors.length, 3);
    assert.equal(errors[2], `History retrieval failed: ${replies[0]}`);
    assert.equal(ev.listenerCount('connection.update'), 0);
    assert.equal(ev.listenerCount('messaging-history.set'), 0);
    assert.equal(ev.listenerCount('messages.upsert'), 0);
  });
}

test('an unavailable anchor never calls AI even when newer text was returned', async t => {
  const f = fixture(t, { rows: [message('newer')] });
  assert.deepEqual(await f.bot.handleMessages([command()]), ['missing-history']);
  assert.equal(f.calls.inputs.length, 0);
  assert.match(f.calls.sends[0].content.text, /newer starting message/);
});

for (const action of ['reconnect', 'close']) {
  test(`${action} during history retrieval prevents AI calls and stale replies`, async t => {
    const entered = deferred();
    const pending = deferred();
    const f = fixture(t, { load: () => { entered.resolve(); return pending.promise; } });
    const processing = f.bot.handleMessages([command()]);
    await entered.promise;
    if (action === 'close') f.bot.close();
    else f.reconnect();
    pending.resolve([message('anchor')]);
    assert.deepEqual(await processing, ['failed']);
    assert.equal(f.calls.inputs.length, 0);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.calls.errors.length, 1);
    assert.match(f.calls.errors[0], /Check the connection/);
    if (action === 'close') {
      assert.deepEqual(await f.bot.handleMessages([command('later')]), ['ignored']);
      assert.equal(await f.bot.getMessage({ remoteJid: GROUP, id: 'out-1' }), undefined);
    }
  });

  test(`${action} while AI is running prevents delivery of the stale summary`, async t => {
    const entered = deferred();
    const pending = deferred();
    const f = fixture(t, { summarize: () => { entered.resolve(); return pending.promise; } });
    const processing = f.bot.handleMessages([command()]);
    await entered.promise;
    if (action === 'close') f.bot.close();
    else f.reconnect();
    pending.resolve('A summary produced after the connection changed.');
    assert.deepEqual(await processing, ['failed']);
    assert.equal(f.calls.inputs.length, 1);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.calls.errors.length, 1);
  });
}

test('a quoted bot message supplies startFromMe and is excluded from the AI transcript', async t => {
  const f = fixture(t, { rows: [
    message('anchor', { key: { remoteJid: GROUP, id: 'anchor', participant: '999@s.whatsapp.net', fromMe: true } }),
    message('friend-response'),
  ] });
  const incoming = command('bot-quote', { participant: '111:8@lid' });
  assert.deepEqual(await f.bot.handleMessages([incoming]), ['summarised']);
  assert.equal(f.calls.loads[0].startParticipant, '111@lid');
  assert.equal(f.calls.loads[0].startFromMe, true);
  assert.deepEqual(f.calls.inputs[0].map(row => row.id), ['friend-response']);
});

test('duplicate deliveries share no extra history or AI work while the original command runs', async t => {
  const entered = deferred();
  const pending = deferred();
  const f = fixture(t, { load: () => { entered.resolve(); return pending.promise; } });
  const incoming = command();
  const processing = f.bot.handleMessages([incoming]);
  await entered.promise;
  assert.deepEqual(await f.bot.handleMessages([incoming]), ['duplicate']);
  assert.equal(f.calls.loads.length, 1);
  pending.resolve([message('anchor')]);
  assert.deepEqual(await processing, ['summarised']);
  assert.deepEqual(await f.bot.handleMessages([incoming]), ['duplicate']);
  assert.equal(f.calls.inputs.length, 1);
  assert.equal(f.calls.sends.length, 1);
});
