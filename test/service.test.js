import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummaryService, isSummariseCommand } from '../src/service.js';

function row(id, extra = {}) {
  return {
    id, groupId: 'friends@g.us', sender: 'Alice', text: `Message ${id}`,
    type: 'chat', timestamp: 1_800_000_000,
    fromBot: false, isCommand: false, deleted: false,
    ...extra,
  };
}

function fixture(options = {}) {
  const anchor = row('anchor');
  const command = row('command', {
    text: '@123 !summarise', timestamp: anchor.timestamp + 60, isCommand: true,
  });
  const rows = options.rows ?? [anchor];
  const replies = [];
  const inputs = [];
  const loads = [];
  let clock = 1000;
  let commandCount = 0;
  const handle = createSummaryService({
    loadMessages: async request => {
      loads.push(request);
      if (options.loadMessages) return options.loadMessages(request);
      return rows.filter(item => item.groupId === request.groupId);
    },
    summarize: options.summarize ?? (async messages => { inputs.push(messages); return 'Plan agreed: meet at noon.'; }),
    reply: async (groupId, id, text) => { replies.push({ groupId, id, text }); },
    now: () => clock,
    cooldownMs: options.cooldownMs ?? 30_000,
  });
  return {
    handle, anchor, command, rows, replies, inputs, loads,
    request: overrides => handle({
      command: { ...command, id: `command-${++commandCount}` },
      mentioned: true, quotedId: 'anchor', ...overrides,
    }),
    advance: ms => { clock += ms; },
  };
}

test('fetches nothing without a standalone command, real mention, and incoming message', async () => {
  for (const text of ['!summarise', '@123 !summarise', '!SUMMARISE @123', 'please !summarise this']) {
    assert.equal(isSummariseCommand(text), true);
  }
  for (const text of [undefined, '', '!summarise-now', 'x!summarise', '!summarised', '@123 summary', '/summarise', '@123 /summarise']) {
    assert.equal(isSummariseCommand(text), false);
  }
  const f = fixture();
  assert.equal(await f.request({ mentioned: false }), 'ignored');
  assert.equal(await f.request({ command: { ...f.command, text: 'hello' } }), 'ignored');
  assert.equal(await f.request({ command: { ...f.command, fromBot: true } }), 'ignored');
  assert.equal(f.replies.length, 0);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.loads.length, 0);
});

test('requests a quote before fetching and clearly reports unavailable history', async () => {
  const f = fixture();
  assert.equal(await f.request({ quotedId: null }), 'missing-quote');
  assert.match(f.replies[0].text, /Reply to the first message/);
  assert.equal(f.loads.length, 0);
  assert.equal(await f.request({ quotedId: 'unavailable' }), 'missing-history');
  assert.match(f.replies[1].text, /newer starting message/);
  assert.equal(f.inputs.length, 0);
  assert.deepEqual(f.loads, [{ groupId: 'friends@g.us', startId: 'unavailable', endId: 'command-2' }]);
});

test('fetches once on demand and summarises only selected text and captions', async () => {
  const f = fixture({ rows: [
    row('anchor'), row('caption', { type: 'image', text: '  dinner at six  ' }),
    row('audio', { type: 'ptt', text: '' }), row('previous-command', { isCommand: true }),
    row('bot-summary', { fromBot: true }), row('removed', { deleted: true }),
    row('other-group', { groupId: 'other@g.us', text: 'Private other group text' }),
  ] });
  assert.equal(f.loads.length, 0);
  assert.equal(await f.request(), 'summarised');
  assert.deepEqual(f.loads, [{ groupId: 'friends@g.us', startId: 'anchor', endId: 'command-1' }]);
  assert.deepEqual(f.inputs[0].map(item => item.id), ['anchor', 'caption']);
  assert.equal(f.inputs[0][1].text, 'dinner at six');
  assert.match(f.replies[0].text, /Summary of 2 available messages/);
  assert.match(f.replies[0].text, /Available text and captions only\./);
  assert.match(f.replies[0].text, /Omitted 1 non-text message\./);
  assert.match(f.replies[0].text, /2027-01-15T08:00:00.000Z/);
  assert.equal(f.replies[0].id, 'command-1');
  assert.equal(f.replies[0].groupId, 'friends@g.us');
  assert.doesNotMatch(f.replies[0].text, /@g\.us|bot-summary|previous-command|restarted|saved/);
});

test('does not call the model for a range without text', async () => {
  const f = fixture({ rows: [row('anchor', { text: '', type: 'image' })] });
  assert.equal(await f.request(), 'empty');
  assert.equal(f.inputs.length, 0);
  assert.match(f.replies[0].text, /no available text messages or captions/);
});

test('subscription limit and sign-in errors give actionable guidance without leaking provider details', async () => {
  for (const [code, expected] of [
    ['PLAN_LIMIT', /ChatGPT usage limit/],
    ['PLAN_UNAVAILABLE', /temporarily unavailable/],
    ['AUTH_REQUIRED', /owner needs to reconnect/],
    ['AUTH_UNAVAILABLE', /temporarily unavailable/],
    ['SUBSCRIPTION_NOT_ENABLED', /authorise ChatGPT plan usage/],
    ['MODEL_UNAVAILABLE', /choose another available model/],
  ]) {
    const f = fixture({ summarize: async () => { throw Object.assign(new Error('private provider detail'), { code }); } });
    assert.equal(await f.request(), 'failed');
    assert.match(f.replies[0].text, expected);
    assert.doesNotMatch(f.replies[0].text, /private provider detail|API key|buy|credit/);
  }
});

test('pauses new history and AI requests after a ChatGPT allowance error', async () => {
  let requests = 0;
  const f = fixture({ summarize: async () => {
    requests++;
    throw Object.assign(new Error('quota'), { code: 'PLAN_LIMIT' });
  } });
  assert.equal(await f.request(), 'failed');
  assert.equal(await f.request(), 'plan-paused');
  assert.equal(requests, 1);
  assert.equal(f.loads.length, 1);
  assert.match(f.replies[1].text, /Summaries are paused/);
});

test('copies the fetched snapshot before generation and permits one request per group', async () => {
  let resolveSummary;
  let resolveStarted;
  let selected;
  const pending = new Promise(resolve => { resolveSummary = resolve; });
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const f = fixture({ summarize: async messages => {
    selected = messages;
    resolveStarted();
    return pending;
  } });
  const job = f.request();
  await started;
  f.rows[0].text = 'Edited after retrieval';
  f.rows.push(row('later-message'));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].text, 'Message anchor');
  assert.equal(await f.request(), 'busy');
  assert.equal(f.loads.length, 1);
  assert.match(f.replies[0].text, /already being prepared/);
  resolveSummary('Snapshot summary');
  assert.equal(await job, 'summarised');
});

test('does not start inference after another group exhausts the shared allowance during history retrieval', async () => {
  let finishHistory;
  let requests = 0;
  const f = fixture({
    loadMessages: ({ groupId }) => groupId === 'second@g.us'
      ? new Promise(resolve => { finishHistory = resolve; })
      : [row('anchor')],
    summarize: async () => {
      requests++;
      throw Object.assign(new Error('quota'), { code: 'PLAN_LIMIT' });
    },
  });
  const pending = f.request({
    command: { ...f.command, id: 'second-command', groupId: 'second@g.us' }, quotedId: 'second-anchor',
  });
  assert.equal(await f.request(), 'failed');
  finishHistory([row('second-anchor', { groupId: 'second@g.us' })]);
  assert.equal(await pending, 'plan-paused');
  assert.equal(requests, 1);
});

test('holds the group lock while retrieving history', async () => {
  let resolveHistory;
  const f = fixture({ loadMessages: () => new Promise(resolve => { resolveHistory = resolve; }) });
  const job = f.request();
  assert.equal(await f.request(), 'busy');
  assert.equal(f.loads.length, 1);
  assert.equal(f.inputs.length, 0);
  resolveHistory([f.anchor]);
  assert.equal(await job, 'summarised');
});

test('different groups can generate summaries concurrently', async () => {
  const resolvers = [];
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const f = fixture({
    rows: [row('anchor'), row('anchor-two', { groupId: 'second@g.us' })],
    summarize: () => new Promise(resolve => {
      resolvers.push(resolve);
      if (resolvers.length === 2) resolveStarted();
    }),
  });
  const first = f.request();
  const second = f.request({
    command: { ...f.command, id: 'command-two', groupId: 'second@g.us' }, quotedId: 'anchor-two',
  });
  await started;
  resolvers.forEach(resolve => resolve('Summary'));
  assert.deepEqual(await Promise.all([first, second]), ['summarised', 'summarised']);
});

test('applies cooldown after success but permits retry with a new command after failure', async () => {
  let attempts = 0;
  const f = fixture({ summarize: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('private token and internal path');
    return 'Ready';
  } });
  assert.equal(await f.request(), 'failed');
  assert.doesNotMatch(f.replies[0].text, /private|token|internal/);
  assert.equal(await f.request(), 'summarised');
  assert.equal(await f.request(), 'cooldown');
  assert.equal(f.loads.length, 2);
  assert.match(f.replies.at(-1).text, /30 seconds/);
  f.advance(30_000);
  assert.equal(await f.request(), 'summarised');
  assert.equal(attempts, 3);
});

test('history and input-size errors give guidance without exposing provider details', async () => {
  const history = fixture({ loadMessages: async () => {
    throw Object.assign(new Error('sensitive history error'), { code: 'HISTORY_UNAVAILABLE' });
  } });
  assert.equal(await history.request(), 'failed');
  assert.match(history.replies[0].text, /newer starting message/);
  assert.equal(history.inputs.length, 0);
  const input = fixture({ summarize: async () => {
    throw Object.assign(new Error('sensitive model error'), { code: 'INPUT_TOO_LARGE' });
  } });
  assert.equal(await input.request(), 'failed');
  assert.match(input.replies[0].text, /too long/);
  assert.doesNotMatch(history.replies[0].text + input.replies[0].text, /sensitive/);
});

test('deduplicates replayed command IDs in memory and expires them after one hour', async () => {
  const f = fixture();
  const request = { command: f.command };
  assert.equal(await f.request(request), 'summarised');
  assert.equal(await f.request(request), 'duplicate');
  assert.equal(f.loads.length, 1);
  assert.equal(f.replies.length, 1);
  f.advance(3_600_000);
  assert.equal(await f.request(request), 'summarised');
  assert.equal(f.loads.length, 2);
});

test('bounds command deduplication to 1000 IDs', async () => {
  const f = fixture();
  assert.equal(await f.request({ command: f.command, quotedId: null }), 'missing-quote');
  for (let index = 0; index < 1000; index += 1) {
    await f.request({ quotedId: null });
  }
  assert.equal(await f.request({ command: f.command, quotedId: null }), 'missing-quote');
  assert.equal(f.loads.length, 0);
});

test('splits long replies without breaking emoji or dropping text', async () => {
  const summary = '🙂'.repeat(4000);
  const f = fixture({ summarize: async () => summary });
  await f.request();
  assert.ok(f.replies.length >= 3);
  for (const { text } of f.replies) {
    assert.ok(text.length <= 3500);
    assert.ok(text.isWellFormed());
  }
  const combined = f.replies.map(item => item.text).join('');
  assert.ok(combined.endsWith(summary));
});
