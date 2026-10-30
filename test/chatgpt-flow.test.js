import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAI } from '../src/ai.js';
import { listModels } from '../src/models.js';
import { createSummarizer } from '../src/summarizer.js';
import { createSummaryService } from '../src/service.js';

async function flow(events) {
  const requests = [];
  const replies = [];
  const diagnostics = [];
  let reads = 0;
  let tokenReads = 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.Authorization, 'Bearer oauth-fixture');
    if (url.endsWith('/models')) {
      return Response.json({ models: [{ slug: 'selected-model', display_name: 'Selected', visibility: 'list' }] });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'selected-model');
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.ok(Array.isArray(body.input));
    assert.equal(body.max_output_tokens, undefined);
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const ai = await prepareAI({ authMode: 'chatgpt', model: 'selected-model', apiKey: 'unused-key' }, {
    authFactory: () => ({
      status: async () => ({ connected: true, planEnabled: true }),
      getAccessToken: async () => { tokenReads++; return 'oauth-fixture'; },
    }),
    listModelsImpl: options => listModels({ ...options, fetchImpl }),
    createSummarizerImpl: options => createSummarizer({ ...options, fetchImpl }),
  });
  const anchor = {
    id: 'anchor', groupId: 'friends@g.us', sender: 'Alice', text: 'Meet at 6pm.',
    timestamp: 1_800_000_000, type: 'chat',
  };
  const handle = createSummaryService({
    loadMessages: async () => { reads++; return [anchor]; },
    summarize: ai.summarize,
    reply: async (_group, _command, text) => { replies.push(text); },
    onError: text => diagnostics.push(text),
  });
  let commandCount = 0;
  const request = () => handle({
    command: { ...anchor, id: `command-${++commandCount}`, text: '@bot !summarise', timestamp: anchor.timestamp + 60 },
    mentioned: true,
    quotedId: 'anchor',
  });
  return { request, replies, requests, diagnostics, reads: () => reads, tokenReads: () => tokenReads };
}

test('account discovery and configured model produce only a completed summary in the group', async () => {
  const f = await flow([
    { type: 'response.output_text.delta', delta: 'UNFINISHED PREVIEW' },
    { type: 'response.completed', response: {
      status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Meet at 6pm.' }] }],
    } },
  ]);
  assert.equal(await f.request(), 'summarised');
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0], /Meet at 6pm/);
  assert.doesNotMatch(f.replies[0], /UNFINISHED/);
  assert.equal(f.tokenReads(), 2);
  assert.equal(f.requests.length, 2);
});

test('a plan failure after text deltas posts guidance, discards partial text, and prevents later inference', async () => {
  const f = await flow([
    { type: 'response.output_text.delta', delta: 'UNFINISHED PRIVATE PREVIEW' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private provider detail' } } },
  ]);
  assert.equal(await f.request(), 'failed');
  assert.equal(await f.request(), 'plan-paused');
  assert.equal(f.reads(), 1);
  assert.equal(f.requests.length, 2);
  assert.match(f.replies[0], /usage limit/);
  assert.match(f.replies[1], /paused/);
  assert.doesNotMatch(f.replies.join('\n'), /UNFINISHED|PRIVATE|private provider detail/);
});

test('an interrupted stream never sends its accumulated text to WhatsApp', async () => {
  const f = await flow([{ type: 'response.output_text.delta', delta: 'UNFINISHED PREVIEW' }]);
  assert.equal(await f.request(), 'failed');
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0], /connection.*ended/i);
  assert.equal(f.diagnostics.length, 1);
  assert.match(f.diagnostics[0], /"stage":"generation","code":"SUMMARY_STREAM_INTERRUPTED"/);
  assert.doesNotMatch(f.replies[0] + f.diagnostics.join(''), /UNFINISHED|oauth-fixture|friends@g.us/);
});
