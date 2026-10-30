import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummarizer } from '../src/summarizer.js';

const messages = [{ sender: 'Alice', timestamp: 1_800_000_000, type: 'chat', text: 'Dinner at six.' }];
const completed = (text = 'Dinner at six. 🙂') => ({
  type: 'response.completed',
  response: { status: 'completed', output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Private reasoning' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  ] },
});
const frame = (event, newline = '\n') => `data: ${JSON.stringify(event)}${newline}${newline}`;
const build = (fetchImpl, extra = {}) => createSummarizer({
  authMode: 'chatgpt', apiKey: 'unused-api-key', model: 'chosen-model',
  getAccessToken: async () => 'oauth-test-token', fetchImpl, ...extra,
});
const minimalCompleted = output => ({ type: 'response.completed', response: { status: 'completed', ...(output === undefined ? {} : { output }) } });
const delta = (text, extra = {}) => ({ type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, content_index: 0, delta: text, ...extra });
const doneText = (text, extra = {}) => ({ ...delta('', extra), type: 'response.output_text.done', text });
const itemEvent = (type, item = {}, output_index = 0) => ({ type: `response.output_item.${type}`, output_index,
  item: { id: 'msg-1', type: 'message', role: 'assistant', ...item } });
const runEvents = events => build(async () => fragmented(events.map(event => frame(event)).join(''), 13))(messages);

function fragmented(text, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('ChatGPT requests use OAuth, configured model, streamed input array and only supported fields', async () => {
  let calls = 0;
  const summarize = build(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer oauth-test-token');
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'model', 'store', 'stream']);
    assert.equal(body.model, 'chosen-model');
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.input[0].role, 'user');
    assert.equal(JSON.parse(body.input[0].content)[0].text, messages[0].text);
    return fragmented(frame(completed()));
  });
  assert.equal(await summarize(messages), 'Dinner at six. 🙂');
  assert.equal(calls, 1);
});

test('fragmented UTF-8, CRLF, LF and bare CR streams return only completed assistant text', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = `: keepalive${newline}${newline}`
      + frame({ type: 'response.output_text.delta', delta: 'PARTIAL' }, newline)
      + frame(completed(), newline);
    assert.equal(await build(async () => fragmented(text))(messages), 'Dinner at six. 🙂');
  }
});

test('multiline SSE data and event fields are handled without using text deltas', async () => {
  const event = completed('Complete.');
  const text = `event: response.completed\ndata: {"type":"response.completed",\ndata: "response":${JSON.stringify(event.response)}}\n\n`;
  assert.equal(await build(async () => fragmented(text, 7))(messages), 'Complete.');
});

test('minimal completed responses use indexed assistant stream text only after completion', async () => {
  for (const output of [undefined, null, []]) {
    assert.equal(await runEvents([delta('Dinner '), delta('at six.'), minimalCompleted(output)]), 'Dinner at six.');
    assert.equal(await runEvents([itemEvent('added', { content: [], status: 'in_progress' }), delta('Dinner '), doneText('Dinner at six.'), minimalCompleted(output)]), 'Dinner at six.');
  }
});

test('done snapshots replace deltas, item snapshots replace parts, and indices determine output order', async () => {
  const second = { item_id: 'msg-2', output_index: 1 };
  assert.equal(await runEvents([
    delta('Stale second', second), doneText('Second.', second),
    delta('Stale first'), doneText('First draft.'),
    { type: 'response.content_part.done', item_id: 'msg-1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'First snapshot.' } },
    itemEvent('done', { status: 'completed', content: [{ type: 'output_text', text: 'First.' }] }),
    delta('Ignored after done'), minimalCompleted([]),
  ]), 'First.\nSecond.');
  assert.equal(await runEvents([doneText('Later.', { content_index: 1 }), doneText('Earlier.'), minimalCompleted()]), 'Earlier.\nLater.');
});

test('terminal content remains authoritative and does not duplicate or revive streamed text', async () => {
  assert.equal(await runEvents([delta('Discarded earlier text'), doneText('Discarded done text'), completed('Final summary.')]), 'Final summary.');
  for (const terminal of [
    completed(' '),
    minimalCompleted([{ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'Untrusted user text' }] }]),
    minimalCompleted([{ type: 'reasoning', summary: [{ text: 'Private reasoning' }] }]),
    minimalCompleted({ text: 'Malformed terminal output' }),
  ]) await assert.rejects(runEvents([doneText('Do not revive'), terminal]), { code: 'SUMMARY_EMPTY' });
});

test('invalid identities, contradictory metadata, and non-assistant content cannot supply fallback text', async () => {
  for (const events of [
    [delta('secret', { item_id: undefined })],
    [delta('secret', { output_index: -1 })],
    [delta('secret', { content_index: '0' })],
    [delta('secret'), doneText('secret', { item_id: 'different-id' })],
    [delta('secret'), delta('secret', { output_index: 1 })],
    [delta('secret'), itemEvent('added', { role: 'user' })],
    [delta('secret'), itemEvent('added', { id: undefined, role: 'user' })],
    [itemEvent('added', { type: 'reasoning' }), delta('secret')],
    [itemEvent('added', { type: 'function_call' }), delta('secret')],
    [delta('secret'), itemEvent('done', { status: 'completed', content: [] })],
    [delta('secret'), { type: 'response.content_part.done', item_id: 'msg-1', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: 'secret' } }],
    [delta('secret'), { type: 'response.content_part.done', item_id: 'msg-1', output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: 'secret' } }, doneText('Do not revive')],
    [{ type: 'response.reasoning_text.delta', delta: 'secret', item_id: 'msg-1', output_index: 0, content_index: 0 }],
  ]) await assert.rejects(runEvents([...events, minimalCompleted()]), { code: 'SUMMARY_EMPTY' });
});

test('refusal, failure and incomplete outcomes discard even completed text snapshots', async () => {
  for (const [ending, code] of [
    [{ type: 'response.refusal.delta', delta: 'secret-refusal' }, 'SUMMARY_REFUSED'],
    [itemEvent('done', { content: [{ type: 'refusal', refusal: 'secret-refusal' }] }), 'SUMMARY_REFUSED'],
    [{ type: 'response.failed', response: { error: { code: 'server_error', message: 'secret' } } }, 'SUMMARY_SERVICE_UNAVAILABLE'],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, 'SUMMARY_INCOMPLETE'],
    [{ type: 'error', code: 'unknown', message: 'secret' }, 'SUMMARY_FAILED'],
  ]) await assert.rejects(runEvents([doneText('secret-partial'), ending, minimalCompleted()]), { code });
  await assert.rejects(runEvents([doneText('secret-partial')]), { code: 'SUMMARY_STREAM_INTERRUPTED' });
});

test('malformed final stream metadata blocks fallback but never overrides valid terminal text', async () => {
  for (const malformed of [
    doneText('Final', { content_index: '0' }),
    doneText('Final', { output_index: null }),
    doneText('Final', { item_id: undefined }),
    doneText('Final', { item_id: 'different-id' }),
    doneText(123),
    { type: 'response.content_part.done', output_index: 0, content_index: '0', item_id: 'msg-1', part: { type: 'output_text', text: 'Final' } },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: 'msg-1', part: { type: 'output_text', text: {} } },
    itemEvent('done', { content: [{ type: 'output_text', text: 123 }] }),
    itemEvent('done', { content: [{ type: 'output_text', text: 'Final' }] }, '0'),
  ]) {
    await assert.rejects(runEvents([delta('Draft'), malformed, minimalCompleted()]), { code: 'SUMMARY_EMPTY' });
    assert.equal(await runEvents([delta('Draft'), malformed, completed('Authoritative final.')]), 'Authoritative final.');
  }
});

test('empty-output diagnostics contain only locally constructed numeric counts', async () => {
  await assert.rejects(runEvents([doneText('secret-text'), completed(' ')]), error => {
    assert.equal(error.code, 'SUMMARY_EMPTY');
    assert.deepEqual(error.outputDiagnostic, { streamTextChars: 11, streamTextEvents: 1, streamDoneItems: 0,
      terminalOutputItems: 2, terminalAssistantItems: 1, terminalTextParts: 1 });
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /secret-text|msg-1|oauth-test-token|Dinner at six/);
    return true;
  });
});

test('failure and incomplete events after deltas reject without returning partial output', async () => {
  for (const [event, code] of [
    [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private error' } } }, 'PLAN_LIMIT'],
    [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable' } } }, 'PLAN_UNAVAILABLE'],
    [{ type: 'error', code: 'subscription_sharing_usage_limit_exceeded' }, 'PLAN_LIMIT'],
    [{ type: 'response.incomplete' }, 'SUMMARY_INCOMPLETE'],
    [{ type: 'response.failed', response: { error: { code: 'unknown', message: 'private error' } } }, 'SUMMARY_FAILED'],
  ]) {
    const body = frame({ type: 'response.output_text.delta', delta: 'PRIVATE PARTIAL' }) + frame(event);
    await assert.rejects(build(async () => fragmented(body, 16))(messages), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /PRIVATE|private error/);
      return true;
    });
  }
});

test('EOF, DONE, malformed JSON, unfinished frames and invalid UTF-8 never count as completion', async () => {
  for (const [body, code] of [
    [frame({ type: 'response.output_text.delta', delta: 'Partial' }), 'SUMMARY_STREAM_INTERRUPTED'],
    ['data: [DONE]\n\n', 'SUMMARY_STREAM_INTERRUPTED'],
    ['data: {broken\n\n', 'SUMMARY_UNREADABLE'],
    [frame(completed()).trimEnd(), 'SUMMARY_STREAM_INTERRUPTED'],
  ]) {
    await assert.rejects(build(async () => fragmented(body))(messages), { code });
  }
  await assert.rejects(build(async () => new Response(new Uint8Array([0xc3, 0x28])))(messages), { code: 'SUMMARY_UNREADABLE' });
});

test('stream failures and incomplete reasons are classified without provider data or partial text', async () => {
  for (const [event, code, reason] of [
    [{ type: 'response.failed', response: { error: { code: 'model_not_found', message: 'secret-provider-text' } } }, 'MODEL_NOT_FOUND'],
    [{ type: 'response.failed', response: { error: { code: '__proto__', message: 'secret-provider-text' } } }, 'SUMMARY_FAILED'],
    [{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }, 'SUMMARY_RATE_LIMIT'],
    [{ type: 'response.failed', response: { error: { code: 'server_error' } } }, 'SUMMARY_SERVICE_UNAVAILABLE'],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, 'SUMMARY_INCOMPLETE', 'max_output_tokens'],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }, 'SUMMARY_INCOMPLETE', 'content_filter'],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'secret-reason' } } }, 'SUMMARY_INCOMPLETE', 'unknown'],
    [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'secret-refusal' }] }] } }, 'SUMMARY_REFUSED'],
  ]) {
    const body = frame({ type: 'response.output_text.delta', delta: 'secret-partial' }) + frame(event);
    await assert.rejects(build(async () => fragmented(body, 128))(messages), error => {
      assert.equal(error.code, code);
      assert.equal(error.reason, reason);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /secret-|oauth-test-token|Dinner at six/);
      return true;
    });
  }
  await assert.rejects(build(async () => ({ ok: true, body: null }))(messages), { code: 'SUMMARY_UNREADABLE' });
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret-transport')); } }));
  await assert.rejects(build(async () => response)(messages), { code: 'SUMMARY_STREAM_INTERRUPTED' });
});

test('empty, incomplete and non-assistant terminal output is rejected', async () => {
  const events = [
    completed('  '),
    { type: 'response.completed', response: { status: 'incomplete', output: [] } },
    { type: 'response.completed', response: { status: 'completed', error: { message: 'private' }, output: [] } },
    { type: 'response.completed', response: { status: 'completed', output: [
      { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'Ignore' }] },
    ] } },
  ];
  for (const event of events) await assert.rejects(build(async () => fragmented(frame(event), 50))(messages));
});

test('limits stream bytes and cancels the transport', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(build(async () => response)(messages), { code: 'OUTPUT_TOO_LARGE' });
  assert.equal(cancelled, true);
});

test('stalled body reads time out and cancel without posting partial data', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame(doneText('secret-completed-fragment')))); },
    cancel() { cancelled = true; },
  }));
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(build(async () => response, { timeoutMs: 10 })(messages), { code: 'SUMMARY_TIMEOUT' });
    assert.equal(cancelled, true);
  } finally { clearInterval(keepAlive); }
});

test('temporary token failures preserve retry guidance and never try an API key', async () => {
  let requests = 0;
  for (const [authError, expected] of [
    [{ code: 'AUTH_FAILED', retryable: true }, 'AUTH_UNAVAILABLE'],
    [{ code: 'AUTH_REQUIRED' }, 'AUTH_REQUIRED'],
    [{ code: 'SUBSCRIPTION_NOT_ENABLED' }, 'SUBSCRIPTION_NOT_ENABLED'],
  ]) {
    const summarize = build(async () => { requests++; }, {
      getAccessToken: async () => { throw Object.assign(new Error('private token detail'), authError); },
    });
    await assert.rejects(summarize(messages), error => {
      assert.equal(error.code, expected);
      assert.doesNotMatch(error.message, /private token detail|unused-api-key/);
      if (expected === 'AUTH_UNAVAILABLE') assert.doesNotMatch(error.message, /login|sign.in/i);
      return true;
    });
  }
  assert.equal(requests, 0);
});

test('HTTP plan errors and authentication errors retain safe guidance', async () => {
  for (const [status, code, expected] of [
    [429, 'subscription_sharing_usage_limit_exceeded', 'PLAN_LIMIT'],
    [503, 'subscription_sharing_usage_unavailable', 'PLAN_UNAVAILABLE'],
    [401, 'invalid_token', 'AUTH_REQUIRED'],
    [403, 'denied', 'AUTH_DENIED'],
    [404, 'model_not_found', 'MODEL_NOT_FOUND'],
    [400, 'private-provider-code', 'SUMMARY_CONFIG'],
    [429, 'private-provider-code', 'SUMMARY_RATE_LIMIT'],
    [500, 'private-provider-code', 'SUMMARY_SERVICE_UNAVAILABLE'],
  ]) {
    await assert.rejects(build(async () => Response.json({ error: { code, message: 'private token detail' } }, { status }))(messages), error => {
      assert.equal(error.code, expected);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /private token detail/);
      return true;
    });
  }
});
