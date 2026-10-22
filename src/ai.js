import { createChatGPTAuth } from './chatgpt-auth.js';
import { listModels, selectModel } from './models.js';
import { createSummarizer } from './summarizer.js';

/** No transcript is sent during startup; validate the account and model first. */
export async function prepareAI(config, {
  authFactory = createChatGPTAuth,
  listModelsImpl = listModels,
  createSummarizerImpl = createSummarizer,
} = {}) {
  let account = null;
  let getAccessToken;
  if (config.authMode === 'chatgpt') {
    const auth = authFactory({ authDir: config.authDir });
    account = await auth.status();
    if (!account.connected) {
      const error = new Error('Sign in with ChatGPT first: npm run login');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    if (!account.planEnabled) {
      const error = new Error('ChatGPT is connected, but plan usage is not enabled. Run npm run login -- --enable-plan and authorise plan usage.');
      error.code = 'SUBSCRIPTION_NOT_ENABLED';
      throw error;
    }
    getAccessToken = () => auth.getAccessToken();
  }
  const authOptions = config.authMode === 'chatgpt'
    ? { authMode: 'chatgpt', getAccessToken }
    : { authMode: 'api-key', apiKey: config.apiKey };
  const models = await listModelsImpl(authOptions);
  const model = selectModel(models, config.model);
  return {
    model, account,
    summarize: createSummarizerImpl({ ...authOptions, model: model.id }),
  };
}
