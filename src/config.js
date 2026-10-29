export function readConfig(env = process.env, { listGroups = false, operation = 'run' } = {}) {
  const authMode = env.AI_AUTH_MODE?.trim() || 'chatgpt';
  if (!['chatgpt', 'api-key'].includes(authMode)) {
    throw new Error('AI_AUTH_MODE must be chatgpt or api-key.');
  }
  const groupIds = new Set((env.ALLOWED_GROUP_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
  if ([...groupIds].some((id) => !/^[0-9-]+@g\.us$/.test(id))) {
    throw new Error('ALLOWED_GROUP_IDS must contain exact group IDs from npm run groups.');
  }
  const runsBot = operation === 'run' && !listGroups;
  if (runsBot && groupIds.size === 0) {
    throw new Error('Run npm run groups, then set ALLOWED_GROUP_IDS in .env.');
  }
  if ((runsBot || operation === 'models') && authMode === 'api-key' && !env.OPENAI_API_KEY?.trim()) {
    throw new Error('Set OPENAI_API_KEY for api-key mode, or use AI_AUTH_MODE=chatgpt and npm run login.');
  }
  const maxMessages = Number(env.MAX_HISTORY_MESSAGES || 3000);
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 10000) {
    throw new Error('MAX_HISTORY_MESSAGES must be an integer from 1 to 10000.');
  }
  const loginPort = Number(env.CHATGPT_LOGIN_PORT?.trim() || 0);
  if (!Number.isSafeInteger(loginPort) || loginPort < 0 || loginPort > 65535) {
    throw new Error('CHATGPT_LOGIN_PORT must be 0 (automatic) or an integer from 1 to 65535.');
  }
  const historyTimeoutMs = Number(env.HISTORY_TIMEOUT_MS || 60000);
  if (!Number.isSafeInteger(historyTimeoutMs) || historyTimeoutMs < 5000 || historyTimeoutMs > 120000) {
    throw new Error('HISTORY_TIMEOUT_MS must be an integer from 5000 to 120000.');
  }
  return {
    groupIds, maxMessages, authMode, loginPort, historyTimeoutMs,
    whatsappAuthDir: env.WA_AUTH_DIR?.trim() || './.baileys-auth',
    recentMessagesDir: env.RECENT_MESSAGES_DIR?.trim() || './data/recent-messages',
    authDir: env.CHATGPT_AUTH_DIR?.trim() || './.chatgpt-auth',
    // A leftover API key is never passed to the subscription-backed path.
    apiKey: authMode === 'api-key' ? env.OPENAI_API_KEY?.trim() : undefined,
    model: env.OPENAI_MODEL?.trim() || (authMode === 'api-key' ? 'gpt-4.1-mini' : ''),
  };
}
