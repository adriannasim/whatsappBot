import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAI } from '../src/ai.js';
import { readConfig } from '../src/config.js';

const modelList = [{ id: 'model-one', displayName: 'First model' }, { id: 'model-two', displayName: 'Second model' }];
const account = { connected: true, planEnabled: true, email: 'owner@example.test' };

test('subscription mode discovers account models and never passes leftover API credentials', async () => {
  const config = readConfig({ ALLOWED_GROUP_IDS: '123@g.us', OPENAI_MODEL: 'model-two', OPENAI_API_KEY: 'unused-key' });
  let chosen;
  const ai = await prepareAI(config, {
    authFactory: () => ({ status: async () => account, getAccessToken: async () => 'oauth-test' }),
    listModelsImpl: async (options) => {
      assert.equal(options.authMode, 'chatgpt');
      assert.equal(options.apiKey, undefined);
      assert.equal(await options.getAccessToken(), 'oauth-test');
      return modelList;
    },
    createSummarizerImpl: (options) => { chosen = options; return async () => 'summary'; },
  });
  assert.equal(ai.model.id, 'model-two');
  assert.equal(chosen.model, 'model-two');
  assert.equal(chosen.authMode, 'chatgpt');
  assert.equal(chosen.apiKey, undefined);
  assert.equal(await ai.summarize([]), 'summary');
});

test('blank model uses account catalog order and an unavailable explicit model never falls back', async () => {
  const deps = {
    authFactory: () => ({ status: async () => account, getAccessToken: async () => 'oauth-test' }),
    listModelsImpl: async () => modelList,
    createSummarizerImpl: () => async () => 'summary',
  };
  const config = readConfig({ ALLOWED_GROUP_IDS: '123@g.us' });
  assert.equal((await prepareAI(config, deps)).model.id, 'model-one');
  await assert.rejects(prepareAI({ ...config, model: 'unavailable' }, deps), { code: 'MODEL_UNAVAILABLE' });
});

test('missing sign-in stops before model requests or paid fallback', async () => {
  let requested = false;
  await assert.rejects(prepareAI({ authMode: 'chatgpt', apiKey: 'must-not-use' }, {
    authFactory: () => ({ status: async () => ({ connected: false }) }),
    listModelsImpl: async () => { requested = true; return modelList; },
  }), { code: 'AUTH_REQUIRED' });
  assert.equal(requested, false);
});

test('explicit API-key mode stays separate and does not open ChatGPT credentials', async () => {
  let chosen;
  const ai = await prepareAI({ authMode: 'api-key', apiKey: 'api-test', model: 'model-one' }, {
    authFactory: () => { throw new Error('Should not load OAuth'); },
    listModelsImpl: async (options) => {
      assert.deepEqual(options, { authMode: 'api-key', apiKey: 'api-test' });
      return modelList;
    },
    createSummarizerImpl: (options) => { chosen = options; return async () => 'summary'; },
  });
  assert.equal(ai.account, null);
  assert.equal(chosen.apiKey, 'api-test');
  assert.equal(chosen.getAccessToken, undefined);
});

test('identity-only sign-in cannot send plan requests or use an API key fallback', async () => {
  let requested = false;
  await assert.rejects(prepareAI({ authMode: 'chatgpt', apiKey: 'unused' }, {
    authFactory: () => ({ status: async () => ({ connected: true, planEnabled: false }) }),
    listModelsImpl: async () => { requested = true; return modelList; },
  }), { code: 'SUBSCRIPTION_NOT_ENABLED' });
  assert.equal(requested, false);
});

test('model listing auth failures propagate without retrying with API keys', async () => {
  let tries = 0;
  await assert.rejects(prepareAI({ authMode: 'chatgpt', apiKey: 'unused' }, {
    authFactory: () => ({ status: async () => account, getAccessToken: async () => 'oauth-test' }),
    listModelsImpl: async () => { tries++; throw Object.assign(new Error('sign in again'), { code: 'AUTH_REQUIRED' }); },
  }), { code: 'AUTH_REQUIRED' });
  assert.equal(tries, 1);
});
