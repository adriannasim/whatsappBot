import { getIncomingCommand, normalizeMessages, sameUser } from './adapter.js';
import { createOnDemandHistory } from './history.js';
import { HistoryUnavailableError } from './history-error.js';
import { createRecentMessageBuffer } from './recent-messages.js';
import { createSummaryService } from './service.js';

const keyFor = (groupId, id) => JSON.stringify([groupId, id]);
const RETRY_TTL_MS = 5 * 60 * 1000;
const MAX_RETRY_MESSAGES = 50;
const MAX_ACTIVE_COMMANDS = 64;

/** Summarize received ranges from bounded RAM, with best-effort phone backfill. */
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
  const recent = createRecentMessageBuffer({ groupIds: config.groupIds, now });
  let bufferSocket = getSocket();
  const activeCommands = new Map();
  // Only the bot's own recent replies, for Baileys delivery retries.
  const outgoing = new Map();
  let closed = false;
  function pruneOutgoing() {
    for (const [key, entry] of outgoing) {
      if (now() - entry.createdAt >= RETRY_TTL_MS) outgoing.delete(key);
    }
  }
  const expiryTimer = setInterval(() => { pruneOutgoing(); recent.prune(); }, 60_000);
  expiryTimer.unref?.();

  const handle = createSummaryService({
    summarize, onPause, onError, now,
    loadMessages: async ({ groupId, startId, endId }) => {
      const context = activeCommands.get(keyFor(groupId, endId));
      if (closed || !context || context.socket !== getSocket()) throw new Error('Connection changed');
      const ownIds = getOwnIds();
      const startFromMe = context.quotedParticipant
        ? ownIds.some(id => sameUser(id, context.quotedParticipant)) : undefined;
      const request = {
        groupId,
        startId,
        startParticipant: context.quotedParticipant,
        startFromMe,
        endKey: { ...context.raw.key, fromMe: false },
        endTimestamp: context.command.timestamp,
      };
      let messages = recent.load(request);
      if (messages !== null) {
        if (messages.length > config.maxMessages) {
          throw new HistoryUnavailableError('That range exceeds the message limit. Reply to a newer starting message and send !summarise again.');
        }
        try { onError(`History diagnostic: ${JSON.stringify({ reason: 'recent_buffer', retained: messages.length })}`); }
        catch { /* Diagnostics cannot prevent a summary. */ }
      } else {
        messages = await history.load(request);
      }
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
    handleMessages: messages => {
      if (!Array.isArray(messages)) return Promise.resolve([]);
      if (!closed) {
        const socket = getSocket();
        if (socket !== bufferSocket) recent.clear();
        bufferSocket = socket;
        // Record the whole batch before any command takes its range snapshot.
        if (socket) recent.add(messages);
      }
      return Promise.all(messages.map(handleOne));
    },
    invalidateMessages: keys => { if (!closed) recent.invalidate(keys); },
    discardGroup: groupId => { if (!closed) recent.discardGroup(groupId); },
    clearRecentMessages() {
      recent.clear();
      bufferSocket = undefined;
    },
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
      recent.clear();
    },
  };
}
