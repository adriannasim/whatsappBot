import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';

test('configuration requires explicit groups and defaults to ChatGPT plan usage', () => {
  assert.equal(readConfig({}, { listGroups: true }).groupIds.size, 0);
  assert.throws(() => readConfig({ OPENAI_API_KEY: 'test' }), /ALLOWED_GROUP_IDS/);
  assert.throws(() => readConfig({ ALLOWED_GROUP_IDS: '123@g.us', AI_AUTH_MODE: 'api-key' }), /OPENAI_API_KEY/);
  assert.throws(() => readConfig({ ALLOWED_GROUP_IDS: '123@c.us', OPENAI_API_KEY: 'test' }), /exact group IDs/);
  assert.throws(() => readConfig({ MAX_HISTORY_MESSAGES: 'Infinity' }, { listGroups: true }), /integer/);
  const config = readConfig({ ALLOWED_GROUP_IDS: '123@g.us', OPENAI_API_KEY: 'test' });
  assert.equal(config.maxMessages, 3000);
  assert.equal(config.authMode, 'chatgpt');
  assert.equal(config.apiKey, undefined);
  assert.equal(config.model, '');
  assert.equal(readConfig({ OPENAI_MODEL: ' selected-model ' }, { operation: 'login' }).model, 'selected-model');
});

test('remote login uses a valid port and Baileys history requests have a bounded timeout', () => {
  const read = env => readConfig(env, { operation: 'login' });
  assert.equal(read({}).loginPort, 0);
  assert.equal(read({}).whatsappAuthDir, './.baileys-auth');
  assert.equal(read({}).recentMessagesDir, './data/recent-messages');
  assert.equal(read({ RECENT_MESSAGES_DIR: './private-cache' }).recentMessagesDir, './private-cache');
  assert.equal(read({}).historyTimeoutMs, 60000);
  assert.equal(read({ CHATGPT_LOGIN_PORT: '17778' }).loginPort, 17778);
  assert.equal(read({ WA_AUTH_DIR: './session', HISTORY_TIMEOUT_MS: '45000' }).whatsappAuthDir, './session');
  assert.equal(read({ HISTORY_TIMEOUT_MS: '45000' }).historyTimeoutMs, 45000);
  for (const value of ['-1', '65536', '1.5', 'Infinity', 'bad']) {
    assert.throws(() => read({ CHATGPT_LOGIN_PORT: value }), /CHATGPT_LOGIN_PORT/);
  }
  for (const value of ['-1', '4999', '120001', 'NaN', '1.2']) {
    assert.throws(() => read({ HISTORY_TIMEOUT_MS: value }), /HISTORY_TIMEOUT_MS/);
  }
});
