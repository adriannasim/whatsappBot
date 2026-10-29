import qrcode from 'qrcode-terminal';
import { readConfig } from './config.js';
import { prepareAI } from './ai.js';
import { createWhatsAppConnection } from './connection.js';
import { createWhatsAppBot } from './bot.js';
import { openRecentMessageStore } from './recent-store.js';

process.umask(0o077);
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
const listGroups = process.argv.includes('--list-groups');
let config;
let ai;
let recentStore;
let savedRecent;
try {
  config = readConfig(process.env, { listGroups });
  if (!listGroups) {
    recentStore = await openRecentMessageStore({
      directory: config.recentMessagesDir,
      onWarning: message => console.error(clean(message)),
    });
    savedRecent = await recentStore.load();
    ai = await prepareAI(config);
    console.log(`Summary model: ${clean(ai.model.id)}`);
    if (config.authMode === 'chatgpt') {
      console.log(`Using the ChatGPT plan for ${clean(ai.account.email || ai.account.name || 'the signed-in account')}.`);
      console.log('Manage usage: https://chatgpt.com/settings/usage . No fallback to API-key billing.');
    } else {
      console.log('Using API-key mode with separate API billing.');
    }
  }
} catch (error) {
  console.error(clean(error.message));
  process.exit(1);
}

let stopping = false;
let bot;
let connection;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await bot?.close();
  try { await connection?.stop(); } catch { /* Transport may already be closed. */ }
  process.exit(exitCode);
}

const failureMessages = {
  WHATSAPP_LOGGED_OUT: 'WhatsApp logged out this linked device. Stop the bot, move the private WA_AUTH_DIR aside, then restart and pair again.',
  WHATSAPP_SESSION_INVALID: 'WhatsApp could not use this session. Stop the bot, move the private WA_AUTH_DIR aside, and pair again.',
  WHATSAPP_CONNECTION_REPLACED: 'Another connection replaced this bot. Run only one instance for each WhatsApp session.',
  WHATSAPP_FORBIDDEN: 'WhatsApp refused the connection. Check the bot account on its phone before restarting.',
  WHATSAPP_RECONNECT_FAILED: 'WhatsApp could not reconnect after several attempts. Check connectivity and restart.',
  WHATSAPP_AUTH_SAVE_FAILED: 'Could not save WhatsApp credentials. Check WA_AUTH_DIR permissions and available disk space.',
  WHATSAPP_START_FAILED: 'Could not start WhatsApp. Run npm run runtime:check and check WA_AUTH_DIR permissions.',
};

connection = createWhatsAppConnection({
  authDir: config.whatsappAuthDir,
  log: message => console.log(clean(message)),
  onQR: qr => {
    console.log('On the bot phone: WhatsApp > Linked devices > Link a device. Scan this QR.');
    qrcode.generate(qr, { small: true });
  },
  getMessage: key => bot?.getMessage(key),
  onMessages: messages => bot?.handleMessages(messages),
  onReplayMessages: messages => bot?.handleReplayMessages(messages),
  onMessageChanges: keys => bot?.invalidateMessages(keys),
  onChatMessagesDeleted: groupId => bot?.discardGroup(groupId),
  onDisconnect: () => bot?.markDisconnected(),
  onOpen: async socket => {
    if (stopping) return;
    if (!listGroups) {
      bot?.onConnected();
      console.log(`Ready in ${config.groupIds.size} selected group(s). Commands: !gm, !gn, and @mention !summarise replies.`);
      console.log('Private recent-message cache: up to 24 hours and 3000 messages per selected group. Saved messages survive restarts; missed-message recovery is best-effort.');
      return;
    }
    try {
      const groups = Object.values(await socket.groupFetchAllParticipating());
      if (stopping || socket !== connection.getSocket()) return;
      if (!groups.length) console.log('No groups found. Add the bot number to your group, then run this command again.');
      for (const group of groups) console.log(`${clean(group.id)}\t${clean(group.subject)}`);
      await stop();
    } catch {
      if (stopping || socket !== connection.getSocket()) return;
      console.error('Could not list groups. Check the linked account and try again.');
      await stop(1);
    }
  },
  onFatal: code => {
    console.error(failureMessages[code] || 'WhatsApp stopped. Check the linked account and restart.');
    void stop(1);
  },
});

if (!listGroups) {
  bot = createWhatsAppBot({
    config,
    recentStore,
    savedRecent,
    summarize: ai.summarize,
    getSocket: () => connection.getSocket(),
    getOwnIds: () => connection.getOwnIds(),
    onError: message => console.error(message),
    onPause: () => console.error('Summaries paused: ChatGPT plan limit reached. Check https://chatgpt.com/settings/usage and restart the bot after access is restored.'),
  });
  savedRecent = undefined;
}

process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
connection.start().catch(() => { void stop(1); });
