const MODELS_ENDPOINT = 'https://api.openai.com/v1/models';

function failure(message, code = 'MODELS_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidCatalog() {
  return failure('The model catalog could not be read. Please try listing models again.');
}

/** Discover models for the selected authentication mode; never substitute credentials. */
export async function listModels({
  authMode = 'chatgpt',
  apiKey,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  if (authMode !== 'chatgpt' && authMode !== 'api-key') {
    throw new TypeError('authMode must be chatgpt or api-key');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError('timeoutMs must be an integer between 1 and 2147483647');
  }

  let credential;
  if (authMode === 'chatgpt') {
    if (typeof getAccessToken !== 'function') {
      throw failure('Sign in with ChatGPT before listing models.', 'AUTH_REQUIRED');
    }
    // Refresh and session failures retain the auth module's safe error and code.
    credential = await getAccessToken();
  } else {
    credential = apiKey;
  }
  if (typeof credential !== 'string' || !credential.trim()) {
    throw failure(authMode === 'chatgpt'
      ? 'Sign in with ChatGPT before listing models.'
      : 'Set OPENAI_API_KEY before listing API models.', 'AUTH_REQUIRED');
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(MODELS_ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential.trim()}` },
      signal,
    });
  } catch {
    throw failure(signal.aborted
      ? 'The model catalog request timed out. Please try again.'
      : 'Could not reach the model catalog. Please try again later.');
  }
  if (!response?.ok) {
    if (response?.status === 401 || response?.status === 403) {
      throw failure(authMode === 'chatgpt'
        ? 'Model access was denied. Sign in with ChatGPT again and check plan permissions.'
        : 'Model access was denied. Check OPENAI_API_KEY and API access.', 'AUTH_FAILED');
    }
    // Do not read or echo provider error bodies.
    throw failure('Could not load the available models. Please try again later.');
  }

  let result;
  try { result = await response.json(); }
  catch {
    if (signal.aborted) throw failure('The model catalog request timed out. Please try again.');
    throw invalidCatalog();
  }

  const source = authMode === 'chatgpt' ? result?.models : result?.data;
  if (!Array.isArray(source)) throw invalidCatalog();
  const models = [];
  const ids = new Set();
  for (const model of source) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw invalidCatalog();
    if (authMode === 'chatgpt' && model.visibility !== 'list') continue;
    const value = authMode === 'chatgpt' ? model.slug : model.id;
    if (typeof value !== 'string' || !value.trim()) throw invalidCatalog();
    const id = value.trim();
    if (ids.has(id)) continue;
    ids.add(id);
    const displayName = authMode === 'chatgpt' && typeof model.display_name === 'string'
      ? model.display_name.trim() || id
      : id;
    models.push({ id, displayName });
  }
  if (!models.length) {
    throw failure('No models are available to this account. Check its access and sign-in permissions.');
  }
  return models;
}

/** An explicit model selection must be available; blank selects the server's first model. */
export function selectModel(models, requested) {
  if (!Array.isArray(models) || !models.length
    || models.some((model) => !model || typeof model.id !== 'string' || !model.id.trim())) {
    throw failure('No model is available. Run npm run models to check this account.', 'MODEL_UNAVAILABLE');
  }
  if (requested === undefined || requested === null || requested === '') return models[0];
  if (typeof requested !== 'string') {
    throw failure('OPENAI_MODEL must be a model ID from npm run models.', 'MODEL_UNAVAILABLE');
  }
  const id = requested.trim();
  if (!id) return models[0];
  const match = models.find((model) => model.id === id);
  if (!match) {
    throw failure('The configured model is not available to this account. Run npm run models and choose one of its IDs.', 'MODEL_UNAVAILABLE');
  }
  return match;
}
