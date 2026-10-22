import { readConfig } from './config.js';
import { createChatGPTAuth } from './chatgpt-auth.js';
import { listModels } from './models.js';

process.umask(0o077);
const [command = 'account', ...args] = process.argv.slice(2);
const MANAGE_USAGE = 'https://chatgpt.com/settings/usage';
const clean = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');

async function main() {
  if (!['login', 'logout', 'account', 'models'].includes(command)) {
    throw new Error('Use login, logout, account, or models.');
  }
  const config = readConfig(process.env, { operation: command });
  const auth = createChatGPTAuth({ authDir: config.authDir, port: config.loginPort });
  if (command === 'login') {
    console.log('Continue with ChatGPT');
    console.log('Authorise WhatsApp Summary Bot to use your ChatGPT plan for group summaries.');
    console.log('Usage counts toward your plan allowance. This does not grant access to your ChatGPT conversations.');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once('SIGINT', cancel);
    let account;
    try {
      account = await auth.login({
        newAccount: args.includes('--new-account'),
        enablePlan: args.includes('--enable-plan'),
        signal: abort.signal,
        onAuthorize: (value) => {
          // ID-token hints must never appear in terminal output or copied URLs.
          const url = new URL(value);
          url.searchParams.delete('id_token_hint');
          console.log('\nOpen this URL in a browser on the same computer as this command:\n');
          console.log(url.toString());
          console.log('\nComplete sign-in in the browser. This terminal will finish automatically.');
        },
      });
    } finally {
      process.removeListener('SIGINT', cancel);
    }
    account = account || await auth.status();
    console.log(`\nConnected: ${clean(account.email || account.name || 'ChatGPT account')}`);
    console.log(account.planEnabled
      ? 'ChatGPT plan usage is enabled. Run npm run models to choose a model.'
      : 'Identity sign-in succeeded, but plan usage is not enabled. Run npm run login -- --enable-plan and authorise plan usage.');
    console.log(`Manage usage: ${MANAGE_USAGE}`);
    if (config.authMode !== 'chatgpt') console.log('Set AI_AUTH_MODE=chatgpt in .env to use this sign-in.');
    return;
  }
  if (command === 'logout') {
    const result = await auth.logout();
    console.log('Local sign-in tokens for the active account have been removed.');
    if (!result?.remoteRevoked) {
      console.log('Remote revocation could not be confirmed. Remove the app under ChatGPT Settings > Security and login > Login connections to revoke access.');
    }
    return;
  }
  if (command === 'account') {
    if (args[0] === 'use') {
      if (!args[1]) throw new Error('Choose a saved registration: npm run account -- use CLIENT_ID');
      await auth.selectAccount(args[1]);
      console.log('Account selected. Restart a running bot to refresh its model selection.');
    } else if (args[0] === 'list') {
      const accounts = await auth.listAccounts();
      if (!accounts.length) console.log('No saved accounts. Run npm run login.');
      for (const item of accounts) {
        console.log(`${clean(item.clientId)}\t${clean(item.email || item.name || 'ChatGPT account')}${item.active ? '\t(active)' : ''}`);
      }
      return;
    } else if (args.length) {
      throw new Error('Use npm run account, npm run account -- list, or npm run account -- use CLIENT_ID.');
    }
    const account = await auth.status();
    console.log(`Authentication mode: ${config.authMode}`);
    console.log(`ChatGPT account: ${clean(account.email || account.name || 'not connected')}`);
    console.log(`ChatGPT plan connection: ${account.connected && account.planEnabled ? 'enabled' : 'sign-in required'}`);
    console.log(`Configured model: ${clean(config.model || '(first available model; run npm run models)')}`);
    console.log(`Manage usage: ${MANAGE_USAGE}`);
    return;
  }
  const models = await listModels(config.authMode === 'chatgpt'
    ? { authMode: 'chatgpt', getAccessToken: () => auth.getAccessToken() }
    : { authMode: 'api-key', apiKey: config.apiKey });
  console.log(config.authMode === 'chatgpt' ? 'Models available through your ChatGPT account:' : 'Models available through your API account:');
  for (const model of models) console.log(`${clean(model.id)}\t${clean(model.displayName)}`);
  console.log('\nSet OPENAI_MODEL to the exact model ID in .env, then restart the bot.');
  if (models.length === 0) console.log('No visible models were returned. Check the selected account and plan permissions.');
}

main().catch((error) => {
  // Library errors are sanitised; no credentials, provider bodies or transcript logs.
  console.error(clean(error.message || 'The command failed. Please try again.'));
  process.exitCode = 1;
});
