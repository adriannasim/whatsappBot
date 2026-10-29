import { getIncomingCommand, normalizeMessages, sameUser } from './adapter.js';
import { createOnDemandHistory } from './history.js';
import { createSummaryService } from './service.js';

const keyFor = (groupId, id) => JSON.stringify([groupId, id]);
const RETRY_TTL_MS = 5 * 60 * 1000;
const MAX_RETRY_MESSAGES = 50;
const MAX_ACTIVE_COMMANDS = 64;

/** Wire live Baileys commands to the summarizer without archiving incoming chats. */
export function createWhatsAppBot({
  config,
  summarize,
  getSocket,
  getOwnIds,
  history,
  onPause = () => {},
  onError = () => {},
  now = Date.now,
}) {
  history ??= createOnDemandHistory({
    getSocket, maxMessages: config.maxMessages, timeoutMs: config.historyTimeoutMs,
    onDiagnostic: diagnostic => onError(`History diagnostic: ${JSON.stringify(diagnostic)}`),
  });
  const activeCommands = new Map();
  // Only the bot's own recent replies, for Baileys delivery retries.
  const outgoing = new Map();
  let closed = false;
  function pruneOutgoing() {
    for (const [key, entry] of outgoing) {
      if (now() - entry.createdAt >= RETRY_TTL_MS) outgoing.delete(key);
    }
  }
  const expiryTimer = setInterval(pruneOutgoing, 60_000);
  expiryTimer.unref?.();

  const handle = createSummaryService({
    summarize, onPause, onError, now,
    loadMessages: async ({ groupId, startId, endId }) => {
      const context = activeCommands.get(keyFor(groupId, endId));
      if (closed || !context || context.socket !== getSocket()) throw new Error('Connection changed');
      const ownIds = getOwnIds();
      const startFromMe = context.quotedParticipant
        ? ownIds.some(id => sameUser(id, context.quotedParticipant)) : undefined;
      const messages = await history.load({
        groupId,
        startId,
        startParticipant: context.quotedParticipant,
        startFromMe,
        endKey: { ...context.raw.key, fromMe: false },
        endTimestamp: context.command.timestamp,
      });
      if (closed || context.socket !== getSocket()) throw new Error('Connection changed');
      // Copy immediately: later history events cannot mutate the AI transcript.
      return normalizeMessages(messages, groupId, { ownIds });
    },
    reply: async (groupId, commandId, text) => {
      const context = activeCommands.get(keyFor(groupId, commandId));
      const socket = getSocket();
      if (closed || !context || !socket || context.socket !== socket) throw new Error('Connection changed');
      const sent = await socket.sendMessage(
        groupId,
        { text, mentions: [], linkPreview: null },
        { quoted: context.raw },
      );
      if (!closed && sent?.key?.id && sent.message) {
        pruneOutgoing();
        if (outgoing.size >= MAX_RETRY_MESSAGES) outgoing.delete(outgoing.keys().next().value);
        outgoing.set(keyFor(groupId, sent.key.id), { message: sent.message, createdAt: now() });
      }
    },
  });

  async function handleOne(raw) {
    if (closed || !config.groupIds.has(raw?.key?.remoteJid)) return 'ignored';
    const context = getIncomingCommand(raw, getOwnIds());
    if (!context?.mentioned) return 'ignored';
    const key = keyFor(context.command.groupId, context.command.id);
    if (activeCommands.has(key)) return 'duplicate';
    if (activeCommands.size >= MAX_ACTIVE_COMMANDS) return 'busy';
    context.socket = getSocket();
    if (!context.socket) return 'disconnected';
    activeCommands.set(key, context);
    try {
      return await handle(context);
    } catch {
      try { onError('Could not process or deliver a summary. Check the connection, then send a new command.'); }
      catch { /* Logging cannot retain the active command. */ }
      return 'failed';
    } finally {
      activeCommands.delete(key);
    }
  }

  return {
    handleMessages: messages => Array.isArray(messages)
      ? Promise.all(messages.map(handleOne)) : Promise.resolve([]),
    getMessage: async key => {
      if (closed || !config.groupIds.has(key?.remoteJid)) return undefined;
      pruneOutgoing();
      return outgoing.get(keyFor(key.remoteJid, key.id))?.message;
    },
    close() {
      closed = true;
      clearInterval(expiryTimer);
      history.close();
      activeCommands.clear();
      outgoing.clear();
    },
  };
}
