import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels, selectModel } from '../src/models.js';

const response = (result) => ({ ok: true, status: 200, json: async () => result });

test('discovers only visible subscription models in server order using fresh OAuth credentials', async () => {
  let refreshes = 0;
  const catalog = {
    models: [
      { slug: 'preferred', display_name: 'Preferred model', visibility: 'list' },
      { slug: 'hidden', visibility: 'hide' },
      { slug: 'alternate', visibility: 'list' },
      { slug: 'preferred', display_name: 'Duplicate', visibility: 'list' },
    ],
  };
  const options = {
    apiKey: 'must-not-be-used',
    getAccessToken: async () => `oauth-${++refreshes}`,
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/models');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.Authorization, `Bearer oauth-${refreshes}`);
      assert.ok(request.signal instanceof AbortSignal);
      assert.equal(request.body, undefined);
      return response(catalog);
    },
  };
  const expected = [
    { id: 'preferred', displayName: 'Preferred model' },
    { id: 'alternate', displayName: 'alternate' },
  ];
  assert.deepEqual(await listModels(options), expected);
  assert.deepEqual(await listModels(options), expected);
  assert.equal(refreshes, 2);
});

test('API-key mode uses only the explicit API key and the API data catalog', async () => {
  const result = await listModels({
    authMode: 'api-key', apiKey: ' api-token ',
    getAccessToken: async () => assert.fail('API-key mode must not use a ChatGPT session'),
    fetchImpl: async (_url, request) => {
      assert.equal(request.headers.Authorization, 'Bearer api-token');
      return response({ data: [{ id: 'api-model' }] });
    },
  });
  assert.deepEqual(result, [{ id: 'api-model', displayName: 'api-model' }]);
});

test('missing subscription authorization never falls back to an API key', async () => {
  const options = { apiKey: 'present-but-irrelevant', fetchImpl: async () => assert.fail('Must not fetch') };
  await assert.rejects(listModels(options), { code: 'AUTH_REQUIRED' });
  await assert.rejects(listModels({ ...options, getAccessToken: async () => '' }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(listModels({ authMode: 'api-key' }), { code: 'AUTH_REQUIRED' });
});

test('malformed, wrong-format, and empty catalogs fail without inventing model choices', async () => {
  for (const catalog of [null, {}, { data: [{ id: 'not-subscription' }] }, { models: null },
    { models: [null] }, { models: [{ visibility: 'list' }] }, { models: [] },
    { models: [{ slug: 'hidden', visibility: 'hide' }] }]) {
    await assert.rejects(listModels({
      getAccessToken: async () => 'token', fetchImpl: async () => response(catalog),
    }), { code: 'MODELS_UNAVAILABLE' });
  }
});

test('HTTP and parsing errors do not leak provider bodies or credentials', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(listModels({
      getAccessToken: async () => 'secret-token',
      fetchImpl: async () => ({ ok: false, status, json: async () => assert.fail('Must not read error body') }),
    }), (error) => {
      assert.doesNotMatch(error.message, /secret-token/);
      assert.equal(error.code, [401, 403].includes(status) ? 'AUTH_FAILED' : 'MODELS_UNAVAILABLE');
      return true;
    });
  }
  await assert.rejects(listModels({
    getAccessToken: async () => 'token',
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('private-response'); } }),
  }), (error) => { assert.doesNotMatch(error.message, /private-response/); return true; });
});

test('model selection honors explicit choices and rejects unlisted IDs', () => {
  const models = [{ id: 'first', displayName: 'First' }, { id: 'second', displayName: 'Second' }];
  assert.equal(selectModel(models), models[0]);
  assert.equal(selectModel(models, '   '), models[0]);
  assert.equal(selectModel(models, ' second '), models[1]);
  assert.throws(() => selectModel(models, 'missing'), { code: 'MODEL_UNAVAILABLE' });
  assert.throws(() => selectModel([], 'first'), { code: 'MODEL_UNAVAILABLE' });
  assert.throws(() => selectModel(models, 42), { code: 'MODEL_UNAVAILABLE' });
});

test('validates options before making requests', async () => {
  await assert.rejects(listModels({ authMode: 'browser-cookie' }), /authMode/);
  await assert.rejects(listModels({ timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(listModels({ fetchImpl: 1 }), /fetchImpl/);
});

test('aborts slow catalog requests with a safe timeout error', async () => {
  await assert.rejects(listModels({
    getAccessToken: async () => 'token', timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('test deadline')), 500);
      signal.addEventListener('abort', () => { clearTimeout(deadline); reject(signal.reason); }, { once: true });
    }),
  }), /timed out/);
});
