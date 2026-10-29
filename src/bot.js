import { getIncomingCommand, normalizeJid, normalizeMessages, sameUser } from './adapter.js';
import { createOnDemandHistory } from './history.js';
import { HistoryUnavailableError } from './history-error.js';
import { createRecentMessageBuffer } from './recent-messages.js';
import { createSummaryService } from './service.js';

const keyFor = (groupId, id) => JSON.stringify([groupId, id]);
const RETRY_TTL_MS = 5 * 60 * 1000;
const MAX_RETRY_MESSAGES = 50;
const MAX_ACTIVE_COMMANDS = 64;

/** Summarize bounded saved ranges, with best-effort phone recovery for gaps. */
export function createWhatsAppBot({
  config,
  summarize,
  getSocket,
  getOwnIds,
  history,
  recentStore,
  savedRecent,
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
  let owner;
  let pendingOwner;
  let pendingRecent;
  let commandEpoch = Math.floor(now() / 1000);
  let closing;
  let saveWarning = false;
  const activeCommands = new Map();
  // Only the bot's own recent replies, for Baileys delivery retries.
  const outgoing = new Map();
  let closed = false;
  function note(message) {
    try { onError(message); } catch { /* Logging cannot change message handling. */ }
  }
  function saveFailure() {
    if (!saveWarning) note('Recent message cache could not be saved. Messages remain in memory, but restart recovery may be incomplete.');
    saveWarning = true;
  }
  function persist() {
    if (!recentStore || (!owner && !pendingRecent)) return Promise.resolve();
    try {
      const snapshot = owner
        ? { version: 1, owner, buffer: recent.snapshot() }
        : { version: 1, owner: pendingOwner ?? null, buffer: pendingRecent.snapshot() };
      return Promise.resolve(recentStore.save(snapshot))
        .then(() => { saveWarning = false; }, saveFailure);
    } catch { saveFailure(); return Promise.resolve(); }
  }
  function bindOwner() {
    const ids = getOwnIds().map(normalizeJid).filter(Boolean);
    const currentOwner = ids.find(id => id.endsWith('@s.whatsapp.net'));
    if (!currentOwner) return false;
    if (owner === currentOwner) return true;
    recent.clear();
    if (pendingRecent && pendingOwner === currentOwner) {
      try { recent.restore(pendingRecent.snapshot()); }
      catch { note('Saved recent messages were invalid and were discarded.'); }
    }
    pendingRecent?.clear();
    pendingRecent = undefined;
    pendingOwner = undefined;
    owner = currentOwner;
    recent.markGap();
    return true;
  }
  function syncConnection() {
    const socket = getSocket();
    if (!socket || !bindOwner()) return false;
    if (socket !== bufferSocket) {
      recent.markGap();
      bufferSocket = socket;
      commandEpoch = Math.floor(now() / 1000);
    }
    return true;
  }
  function pruneOutgoing() {
    for (const [key, entry] of outgoing) {
      if (now() - entry.createdAt >= RETRY_TTL_MS) outgoing.delete(key);
    }
  }
  if (savedRecent != null) {
    // Enforce retention even before WhatsApp can connect. This quarantined
    // buffer cannot supply summaries until the authenticated account matches.
    pendingRecent = createRecentMessageBuffer({ groupIds: config.groupIds, now });
    const savedOwner = normalizeJid(savedRecent.owner);
    if (savedRecent.version === 1 && savedOwner.endsWith('@s.whatsapp.net') && savedOwner === savedRecent.owner) {
      pendingOwner = savedOwner;
      try { pendingRecent.restore(savedRecent.buffer); }
      catch { note('Saved recent messages were invalid and were discarded.'); }
    } else if (savedRecent.owner !== null || savedRecent.buffer?.entries?.length !== 0) {
      note('Saved recent messages were invalid and were discarded.');
    }
    void persist();
  }
  savedRecent = undefined;
  const expiryTimer = setInterval(() => { pruneOutgoing(); recent.prune(); void persist(); }, 60_000);
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
      let coverageIncomplete = false;
      if (messages !== null) {
        try { onError(`History diagnostic: ${JSON.stringify({ reason: 'recent_buffer', retained: messages.length })}`); }
        catch { /* Diagnostics cannot prevent a summary. */ }
      } else {
        try {
          messages = await history.load(request);
          if (!closed && context.socket === getSocket()) {
            recent.addReplay(messages);
            void persist();
          }
        }
        catch (error) {
          if (error?.code !== 'HISTORY_UNAVAILABLE' || closed || context.socket !== getSocket()) throw error;
          // Preserve the exact anchor and command. Only a range whose gap is
          // explicitly reported may fall back to the saved/received subset.
          const available = recent.loadAvailable(request);
          if (!available?.gapCount) throw error;
          messages = available.messages;
          coverageIncomplete = true;
          note(`History diagnostic: ${JSON.stringify({ reason: 'saved_range_with_gap', retained: messages.length })}`);
        }
      }
      if (messages.length > config.maxMessages) {
        throw new HistoryUnavailableError('That range exceeds the message limit. Reply to a newer starting message and send !summarise again.');
      }
      if (closed || context.socket !== getSocket()) throw new Error('Connection changed');
      // Copy immediately: later history events cannot mutate the AI transcript.
      const normalized = normalizeMessages(messages, groupId, { ownIds });
      return coverageIncomplete ? { messages: normalized, coverageIncomplete: true } : normalized;
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
    // Old replayed commands must never spend another AI request on reconnect.
    if (context.command.timestamp < commandEpoch) return 'ignored';
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
      if (closed || !syncConnection()) return Promise.resolve(messages.map(() => 'ignored'));
      const duplicateIds = new Set();
      {
        for (const raw of messages) {
          if (recent.has(raw?.key)) duplicateIds.add(keyFor(raw.key.remoteJid, raw.key.id));
        }
        // Record the whole batch before any command takes its range snapshot.
        recent.add(messages);
        if (messages.some(raw => config.groupIds.has(raw?.key?.remoteJid))) void persist();
      }
      return Promise.all(messages.map(raw => duplicateIds.has(keyFor(raw?.key?.remoteJid, raw?.key?.id))
        && getIncomingCommand(raw, getOwnIds())?.mentioned ? 'duplicate' : handleOne(raw)));
    },
    handleReplayMessages: messages => {
      if (closed || !Array.isArray(messages) || !syncConnection()) return;
      recent.addReplay(messages);
      if (messages.some(raw => config.groupIds.has(raw?.key?.remoteJid))) void persist();
    },
    onConnected() {
      if (closed) return;
      syncConnection();
      commandEpoch = Math.floor(now() / 1000);
      void persist();
    },
    invalidateMessages: keys => { if (!closed && bindOwner()) { recent.invalidate(keys); void persist(); } },
    discardGroup: groupId => { if (!closed && bindOwner()) { recent.discardGroup(groupId); void persist(); } },
    markDisconnected() {
      if (closed) return;
      recent.markGap();
      bufferSocket = undefined;
      void persist();
    },
    clearRecentMessages() {
      recent.clear();
      pendingRecent?.clear();
      void persist();
    },
    flush: () => closing ?? persist().then(() => recentStore?.flush()).catch(saveFailure),
    getMessage: async key => {
      if (closed || !config.groupIds.has(key?.remoteJid)) return undefined;
      pruneOutgoing();
      return outgoing.get(keyFor(key.remoteJid, key.id))?.message;
    },
    close() {
      if (closing) return closing;
      closed = true;
      clearInterval(expiryTimer);
      history.close();
      activeCommands.clear();
      outgoing.clear();
      closing = persist().then(() => recentStore?.flush()).catch(saveFailure);
      recent.clear();
      pendingRecent?.clear();
      pendingRecent = undefined;
      return closing;
    },
  };
}
