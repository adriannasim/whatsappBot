import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummarizer } from '../src/summarizer.js';

const messages = [
  { sender: 'Alice', timestamp: 1_700_000_000, text: 'Dinner on Friday?', type: 'chat' },
  { sender: 'Bob', timestamp: 1_700_000_060, text: 'Yes, I will book at 7.', type: 'chat' },
];

function completed(text = 'Friday dinner agreed. Bob will book for 7.') {
  return {
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  };
}

function fakeResponse(result, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => result };
}

test('sends only the transcript with instructions separate and storage disabled', async () => {
  let calls = 0;
  const summarize = createSummarizer({
    apiKey: 'unit-test-key',
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer unit-test-key');
      assert.ok(options.signal instanceof AbortSignal);
      const request = JSON.parse(options.body);
      assert.equal(request.store, false);
      assert.equal(request.model, 'gpt-4.1-mini');
      assert.equal(request.max_output_tokens, 900);
      assert.equal(request.tools, undefined);
      assert.match(request.instructions, /untrusted data/);
      assert.match(request.instructions, /Do not invent/);
      assert.deepEqual(JSON.parse(request.input), [
        { sender: 'Alice', timestamp: '2023-11-14T22:13:20.000Z', text: 'Dinner on Friday?', type: 'chat' },
        { sender: 'Bob', timestamp: '2023-11-14T22:14:20.000Z', text: 'Yes, I will book at 7.', type: 'chat' },
      ]);
      return fakeResponse(completed());
    },
  });
  assert.equal(calls, 0);
  assert.equal(await summarize(messages), 'Friday dinner agreed. Bob will book for 7.');
  assert.equal(calls, 1);
});

test('extracts all text output items without assuming the first output is text', async () => {
  const result = completed();
  result.output = [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Main topic' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Decision' }] },
  ];
  const summarize = createSummarizer({ apiKey: 'test', fetchImpl: async () => fakeResponse(result) });
  assert.equal(await summarize(messages), 'Main topic\nDecision');
});

test('rejects a long transcript before making a request instead of truncating it', async () => {
  const summarize = createSummarizer({
    apiKey: 'test', maxInputChars: 50,
    fetchImpl: async () => assert.fail('Must not send a too-large transcript'),
  });
  await assert.rejects(summarize(messages), (error) => {
    assert.equal(error.code, 'INPUT_TOO_LARGE');
    assert.match(error.message, /newer starting message/);
    return true;
  });
});

test('does not expose provider response bodies for HTTP failures', async () => {
  const summarize = createSummarizer({
    apiKey: 'unit-test-secret',
    fetchImpl: async () => ({
      ok: false, status: 429,
      json: async () => ({ error: { code: 'private-provider-code', message: 'unit-test-secret Dinner on Friday?' } }),
    }),
  });
  await assert.rejects(summarize(messages), error => {
    assert.equal(error.code, 'SUMMARY_RATE_LIMIT');
    assert.equal(error.status, 429);
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-provider-code|unit-test-secret|Dinner on Friday/);
    return true;
  });
});

test('sanitises network errors', async () => {
  const summarize = createSummarizer({
    apiKey: 'test',
    fetchImpl: async () => { throw new Error('secret-message-content'); },
  });
  await assert.rejects(summarize(messages), { code: 'SUMMARY_NETWORK', message: 'Could not reach the summary service. Please try again later.' });
});

test('rejects incomplete output rather than presenting a truncated summary', async () => {
  const summarize = createSummarizer({
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({ ...completed('Partial summary'), status: 'incomplete' }),
  });
  await assert.rejects(summarize(messages), { code: 'SUMMARY_INCOMPLETE', reason: 'unknown' });
});

test('rejects empty or malformed model output', async (t) => {
  for (const result of [completed(' '), { status: 'completed', output: null }, { status: 'completed', output: [null] }]) {
    await t.test(JSON.stringify(result), async () => {
      const summarize = createSummarizer({ apiKey: 'test', fetchImpl: async () => fakeResponse(result) });
      await assert.rejects(summarize(messages), { code: 'SUMMARY_EMPTY' });
    });
  }
});

test('classifies HTTP failures using status and allowlisted codes without exposing provider details', async () => {
  for (const [status, providerCode, expected] of [
    [401, 'secret-auth-detail', 'API_AUTH_FAILED'],
    [403, 'secret-permission-detail', 'API_ACCESS_DENIED'],
    [429, 'secret-quota-detail', 'SUMMARY_RATE_LIMIT'],
    [503, 'secret-service-detail', 'SUMMARY_SERVICE_UNAVAILABLE'],
    [400, 'secret-request-detail', 'SUMMARY_CONFIG'],
    [404, 'model_not_found', 'MODEL_NOT_FOUND'],
  ]) {
    let calls = 0;
    const summarize = createSummarizer({ apiKey: 'secret-token', fetchImpl: async () => {
      calls++;
      return fakeResponse({ error: { code: providerCode, message: 'secret-transcript secret-token' } }, status);
    } });
    await assert.rejects(summarize(messages), error => {
      assert.equal(error.code, expected);
      assert.equal(error.status, status);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /secret-/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('classifies unreadable, refused and incomplete responses without retaining sensitive details', async () => {
  const fixtures = [
    [null, 'SUMMARY_UNREADABLE'],
    [{ status: 'failed', error: { code: 'model_not_found', message: 'secret-provider-text' } }, 'MODEL_NOT_FOUND'],
    [{ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'secret-refusal' }] }] }, 'SUMMARY_REFUSED'],
  ];
  for (const [result, code] of fixtures) {
    await assert.rejects(createSummarizer({ apiKey: 'secret-token', fetchImpl: async () => fakeResponse(result) })(messages), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /secret-/);
      return true;
    });
  }
  for (const reason of ['max_output_tokens', 'content_filter', 'secret-reason']) {
    const summarize = createSummarizer({ apiKey: 'test', fetchImpl: async () => fakeResponse({
      status: 'incomplete', incomplete_details: { reason }, output: completed('secret-partial').output,
    }) });
    await assert.rejects(summarize(messages), { code: 'SUMMARY_INCOMPLETE', reason: reason === 'secret-reason' ? 'unknown' : reason });
  }
  await assert.rejects(createSummarizer({ apiKey: 'test', fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('secret-json'); } }) })(messages), { code: 'SUMMARY_UNREADABLE' });
});

test('rejects malformed transcripts before sending them', async () => {
  const summarize = createSummarizer({
    apiKey: 'test', fetchImpl: async () => assert.fail('Invalid input must not be sent'),
  });
  await assert.rejects(summarize([]), /no text messages/);
  await assert.rejects(summarize([{ text: 'Hi', timestamp: Infinity }]), /could not be read/);
  await assert.rejects(summarize([{ text: ' ', timestamp: 0 }]), /no text messages/);
  await assert.rejects(summarize([null]), /could not be read/);
});

test('validates configuration before the bot starts', () => {
  assert.throws(() => createSummarizer(), /OPENAI_API_KEY/);
  assert.throws(() => createSummarizer({ apiKey: 'test', model: '' }), /OPENAI_MODEL/);
  assert.throws(() => createSummarizer({ apiKey: 'test', maxInputChars: -1 }), /maxInputChars/);
  assert.throws(() => createSummarizer({ apiKey: 'test', timeoutMs: 0 }), /timeoutMs/);
});

test('aborts a slow request and returns a friendly timeout error', async () => {
  const summarize = createSummarizer({
    apiKey: 'test', timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('Test deadline')), 500);
      signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      }, { once: true });
    }),
  });
  await assert.rejects(summarize(messages), /timed out/);
});
