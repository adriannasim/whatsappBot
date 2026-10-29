import { HistoryUnavailableError } from './history-error.js';
import { normalizeMessageContent, proto } from '@whiskeysockets/baileys';

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_EARLY_EVENTS = 32;
const MAX_CHUNKS_PER_PAGE = 128;
const MAX_QUEUED_REQUESTS = 20;
const MAX_PAGE_MESSAGES = 50; // Baileys' documented maximum per history query.

function unavailable(message) {
  return new HistoryUnavailableError(message);
}

function timestampSeconds(value) {
  let number;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'bigint') number = Number(value);
  else if (value && typeof value.toNumber === 'function') number = value.toNumber();
  else if (value && Number.isInteger(value.low) && Number.isInteger(value.high)) {
    number = (value.high >>> 0) * 0x100000000 + (value.low >>> 0);
  }
  if (!Number.isSafeInteger(number) || number <= 0 || !Number.isSafeInteger(number * 1000)) {
    throw unavailable('WhatsApp returned an invalid message timestamp. Please try again.');
  }
  return number;
}

function normalizeParticipant(jid) {
  return typeof jid === 'string' ? jid.replace(/:\d+(?=@)/, '') : '';
}

function matchesParticipant(key, participant) {
  if (!participant) return true;
  const wanted = normalizeParticipant(participant);
  return [key.participant, key.participantAlt].some((value) => normalizeParticipant(value) === wanted);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
}

function validateRequest({ groupId, startId, startParticipant, startFromMe, endKey, endTimestamp } = {}) {
  if (typeof groupId !== 'string' || !groupId.endsWith('@g.us')) throw new TypeError('groupId must be a WhatsApp group JID');
  if (typeof startId !== 'string' || !startId || typeof endKey?.id !== 'string' || !endKey.id) {
    throw new TypeError('startId and endKey.id must be non-empty message IDs');
  }
  if (endKey.remoteJid !== groupId || typeof endKey.fromMe !== 'boolean') {
    throw new TypeError('endKey must be the actual command key from this group');
  }
  if (startParticipant !== undefined && (typeof startParticipant !== 'string' || !startParticipant)) {
    throw new TypeError('startParticipant must be a non-empty JID');
  }
  if (startFromMe !== undefined && typeof startFromMe !== 'boolean') throw new TypeError('startFromMe must be a boolean');
  if (startId === endKey.id) throw unavailable('Please reply to a message that comes before your !summarise command.');
  return { groupId, startId, startParticipant, startFromMe, endKey: { ...endKey }, endTimestamp: timestampSeconds(endTimestamp) };
}

/**
 * Fetch history from the primary phone only while a command is running.
 * Baileys emits reverse chronological pages and returns a request ID, not messages.
 * endTimestamp and fetchMessageHistory both use Unix seconds, despite the
 * protocol field name oldestMsgTimestampMs. See Baileys v7.0.0-rc14's example:
 * https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/Example/example.ts
 * A response without progress metadata is considered settled after settleMs of quiet.
 * This returns the available range, not a guarantee that WhatsApp retained every message.
 */
export function createOnDemandHistory({
  getSocket,
  maxMessages = 3000,
  timeoutMs = 30000,
  settleMs = 750,
  emptyPageRetryMs = 2000,
  onDemandType = 6, // proto.HistorySync.HistorySyncType.ON_DEMAND
  onDiagnostic = () => {},
} = {}) {
  if (typeof getSocket !== 'function') throw new TypeError('getSocket must be a function');
  if (typeof onDiagnostic !== 'function') throw new TypeError('onDiagnostic must be a function');
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new TypeError('maxMessages must be a positive integer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(settleMs) || settleMs < 0) throw new TypeError('settleMs must be a non-negative integer');
  if (!Number.isSafeInteger(emptyPageRetryMs) || emptyPageRetryMs < 0) throw new TypeError('emptyPageRetryMs must be a non-negative integer');
  if (!Number.isSafeInteger(onDemandType) || onDemandType < 0) throw new TypeError('onDemandType must be a non-negative integer');

  const queue = [];
  let active;
  let closed = false;

  async function run(request, controller) {
    const socket = getSocket();
    if (typeof socket?.fetchMessageHistory !== 'function' || typeof socket?.ev?.on !== 'function' || typeof socket?.ev?.off !== 'function') {
      throw unavailable('WhatsApp is not connected. Please try again after it reconnects.');
    }
    const reverseMessages = [];
    const seen = new Set();
    let retainedBytes = 0;
    let page;
    let deadline;
    let abort;
    let pages = 0;
    let pageStats;
    let retries = 0;
    let retryTimer;

    function diagnose(reason) {
      // Only bounded counts and positions from this command. Never include
      // message contents, IDs, participant/group JIDs, or absolute timestamps.
      try {
        onDiagnostic(Object.freeze({ reason, pages, retries, ...pageStats, retained: reverseMessages.length }));
      } catch { /* Diagnostics must not prevent the normal recovery reply. */ }
    }

    function missingAnchor(reason, message) {
      diagnose(reason);
      return unavailable(message);
    }

    function snapshotPage() {
      const chunks = page.chunks;
      const rows = chunks.flatMap(chunk => chunk.rows);
      const stats = {
        requested: page.requested, chunks: chunks.length, pageRows: rows.length,
        cursorIndex: -1, anchorIndex: rows.findIndex(message => message.key.id === request.startId),
        candidateRows: rows.length, ascending: 0, descending: 0, equal: 0,
        payloadProgress: chunks.reduce((highest, chunk) => chunk.progress === null ? highest : Math.max(highest ?? 0, chunk.progress), null),
        notificationProgress: [...page.notifications.values()].reduce((highest, item) => item.progress === null ? highest : Math.max(highest ?? 0, item.progress), null),
        notificationChunkOrder: [...page.notifications.keys()].reduce((highest, order) => order === null ? highest : Math.max(highest ?? 0, order), null),
        ...(chunks.at(-1)?.metadata ?? { chatCount: null, matchingChatCount: null, endOfHistoryTransfer: null, endOfHistoryTransferType: null }),
      };
      for (let index = 1; index < rows.length; index++) {
        const difference = timestampSeconds(rows[index].messageTimestamp) - timestampSeconds(rows[index - 1].messageTimestamp);
        stats[difference > 0 ? 'ascending' : difference < 0 ? 'descending' : 'equal']++;
      }
      return stats;
    }

    const failure = new Promise((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      deadline = setTimeout(() => {
        try { if (page) pageStats = snapshotPage(); } catch { /* A diagnostic cannot prevent timeout. */ }
        diagnose('timeout');
        reject(unavailable('WhatsApp did not finish sending history. Keep the bot account\'s phone online and try again, or reply to a more recent message.'));
      }, timeoutMs);
    });
    // Attach immediately: socket events can arrive before a page starts awaiting it.
    failure.catch(() => {});

    async function matchesVerifiedParticipant(key, participant) {
      if (matchesParticipant(key, participant)) return true;
      const mapping = socket.signalRepository?.lidMapping;
      const wanted = normalizeParticipant(participant);
      const lookup = /@(lid|hosted\.lid)$/.test(wanted) ? mapping?.getPNForLID
        : /@(s\.whatsapp\.net|hosted)$/.test(wanted) ? mapping?.getLIDForPN : undefined;
      if (typeof lookup !== 'function') return false;
      // History protobufs do not carry participantAlt. Baileys stores verified
      // PN/LID mappings before emitting history, so resolve only a matching
      // message ID, after its response arrived. Never equate unrelated users
      // merely because their message IDs or timestamp happen to match.
      const alias = await Promise.race([
        Promise.resolve().then(() => lookup.call(mapping, wanted)).catch(() => undefined),
        failure,
      ]);
      return typeof alias === 'string' && Boolean(alias) && matchesParticipant(key, alias);
    }

    function finishPageSoon() {
      clearTimeout(page?.settleTimer);
      if (!page?.chunks.length) return;
      if (page.unnumberedNotifications > page.chunks.filter(chunk => chunk.order === null).length) return;
      // Without chunk numbers, multiple notifications cannot be paired with
      // downloads safely. Require an explicit completed payload in that case.
      if (page.unnumberedNotifications > 1 && !page.chunks.some(chunk => chunk.progress === 100)) return;
      // Notifications arrive before their payloads are downloaded. Do not let
      // a final notification settle an earlier empty chunk while its own
      // payload is still pending. Match progress by this session's chunk.
      if ([...page.notifications.keys()].some(order => !page.chunks.some(chunk => chunk.order === order))) return;
      const progress = page.chunks.reduce((highest, chunk) => {
        const value = chunk.progress ?? page.notifications.get(chunk.order)?.progress;
        return value == null ? highest : Math.max(highest ?? 0, value);
      }, null);
      if (progress !== null && progress < 100) return;
      page.settleTimer = setTimeout(() => page?.resolve(), settleMs);
    }

    function historyMetadata(event) {
      const chats = Array.isArray(event.chats) && event.chats.length <= maxMessages + 100 ? event.chats : null;
      const matching = chats?.filter(chat => chat?.id === request.groupId);
      const target = matching?.length === 1 ? matching[0] : null;
      return {
        chatCount: chats?.length ?? null,
        matchingChatCount: matching?.length ?? null,
        endOfHistoryTransfer: typeof target?.endOfHistoryTransfer === 'boolean' ? target.endOfHistoryTransfer : null,
        endOfHistoryTransferType: [0, 1, 2].includes(target?.endOfHistoryTransferType) ? target.endOfHistoryTransferType : null,
      };
    }

    function receiveNotification(metadata) {
      if (!page || metadata.session !== page.id) return;
      if (!page.notifications.has(metadata.order) && page.notifications.size >= MAX_CHUNKS_PER_PAGE) {
        page.reject(unavailable('WhatsApp sent too many history chunks. Please try a more recent starting message.'));
        return;
      }
      const previous = page.notifications.get(metadata.order);
      if (metadata.order === null) page.unnumberedNotifications++;
      const progress = metadata.progress === null ? previous?.progress ?? null
        : Math.max(previous?.progress ?? 0, metadata.progress);
      page.notifications.set(metadata.order, { progress });
      finishPageSoon();
    }

    function observeMessages(event) {
      if (!page || !Array.isArray(event?.messages)) return;
      for (const message of event.messages) {
        if (message?.key?.fromMe !== true) continue;
        const protocol = normalizeMessageContent(message.message)?.protocolMessage;
        if (protocol?.type !== proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION) continue;
        const notification = protocol.historySyncNotification;
        const session = notification?.peerDataRequestSessionId;
        if (notification?.syncType !== onDemandType || typeof session !== 'string' || !session) continue;
        const metadata = {
          session,
          progress: Number.isFinite(notification.progress) && notification.progress >= 0 && notification.progress <= 100 ? notification.progress : null,
          order: Number.isSafeInteger(notification.chunkOrder) && notification.chunkOrder >= 0 ? notification.chunkOrder : null,
        };
        if (page.id) receiveNotification(metadata);
        else {
          // Retain only bounded primitive metadata, never the notification,
          // which can contain media credentials or an inline chat payload.
          page.earlyBytes += byteLength(metadata);
          if (page.earlyNotifications.length >= MAX_EARLY_EVENTS || page.earlyBytes + retainedBytes > MAX_BUFFER_BYTES) {
            page.reject(unavailable('That history response is too large. Please reply to a more recent message.'));
            return;
          }
          page.earlyNotifications.push(metadata);
        }
      }
    }

    function onMessages(event) {
      try { observeMessages(event); }
      catch { /* Optional metadata must never prevent Baileys from receiving an event. */ }
    }

    function receiveForPage(event, metadata) {
      if (!page || event.peerDataRequestSessionId !== page.id) return;
      try {
        if (!Array.isArray(event.messages)) throw unavailable('WhatsApp returned malformed history. Please try again.');
        const rows = [];
        for (let message of event.messages) {
          if (message?.key?.remoteJid !== request.groupId) continue;
          if (typeof message.key.id !== 'string' || !message.key.id
            || (message.key.fromMe != null && typeof message.key.fromMe !== 'boolean')) {
            throw unavailable('WhatsApp returned a message without a valid key. Please try again.');
          }
          // Protobuf optional false values may be absent (decoded as null).
          // Baileys treats these as incoming messages. Copy rather than mutate
          // the raw message shared with its event buffer and other consumers.
          if (message.key.fromMe == null) message = { ...message, key: { ...message.key, fromMe: false } };
          timestampSeconds(message.messageTimestamp);
          page.bytes += byteLength(message);
          if (++page.count > maxMessages + 100 || retainedBytes + page.bytes > MAX_BUFFER_BYTES) {
            throw unavailable('That history response is too large. Please reply to a more recent message.');
          }
          rows.push(message);
        }
        // Empty responses can signal exhaustion. Ignore unrelated-group-only events.
        if (!rows.length && event.messages.length) return;
        if (event.progress != null) {
          if (!Number.isFinite(event.progress) || event.progress < 0 || event.progress > 100) {
            throw unavailable('WhatsApp returned invalid history progress. Please try again.');
          }
        }
        if (event.chunkOrder != null && (!Number.isSafeInteger(event.chunkOrder) || event.chunkOrder < 0)) {
          throw unavailable('WhatsApp returned an invalid history chunk. Please try again.');
        }
        if (page.chunks.length >= MAX_CHUNKS_PER_PAGE) throw unavailable('WhatsApp sent too many history chunks. Please try a more recent starting message.');
        page.chunks.push({ rows, order: event.chunkOrder ?? null, progress: event.progress ?? null, metadata, received: page.chunks.length });
        finishPageSoon();
      } catch (error) {
        page.reject(error.code === 'HISTORY_UNAVAILABLE' ? error : unavailable('WhatsApp returned malformed history. Please try again.'));
      }
    }

    function onHistory(event) {
      if (!page || event?.syncType !== onDemandType || typeof event.peerDataRequestSessionId !== 'string' || !event.peerDataRequestSessionId) return;
      if (page.id) {
        receiveForPage(event, historyMetadata(event));
      } else {
        // Events can arrive before fetchMessageHistory resolves with its request ID.
        // Bound this short-lived buffer and replay only the exact matching session.
        try {
          const relevant = Array.isArray(event.messages)
            ? event.messages.filter((message) => message?.key?.remoteJid === request.groupId)
            : event.messages;
          if (Array.isArray(relevant) && event.messages.length && !relevant.length) return;
          const snapshot = {
            messages: relevant,
            peerDataRequestSessionId: event.peerDataRequestSessionId,
            progress: event.progress,
            chunkOrder: event.chunkOrder,
            metadata: historyMetadata(event),
          };
          page.earlyBytes += byteLength(snapshot);
          if (page.early.length >= MAX_EARLY_EVENTS || page.earlyBytes + retainedBytes > MAX_BUFFER_BYTES || (Array.isArray(relevant) && relevant.length > maxMessages + 100)) {
            throw unavailable('That history response is too large. Please reply to a more recent message.');
          }
          page.early.push(snapshot);
        } catch (error) {
          page.reject(error.code === 'HISTORY_UNAVAILABLE' ? error : unavailable('WhatsApp returned malformed history. Please try again.'));
        }
      }
    }

    function onConnection(update) {
      if (update?.connection === 'close') controller.abort(unavailable('WhatsApp disconnected while loading history. Please try again after it reconnects.'));
    }

    const originalEmit = socket.ev.emit;
    let observingRawHistory = false;
    function emitWithHistoryObserver(...args) {
      if (args[0] === 'messaging-history.set') onHistory(args[1]);
      if (args[0] === 'messages.upsert') onMessages(args[1]);
      return Reflect.apply(originalEmit, this, args);
    }
    try {
      if (typeof originalEmit === 'function') {
        // Baileys buffers history events and deduplicates message IDs across
        // requests. Observe each raw response before that buffer can drop an
        // overlapping range or merge its session/chunk metadata. Keep the
        // original emission intact for Baileys and other consumers, and do not
        // also subscribe to the later buffered copy. This observer lives only
        // for this command and retains no conversation between commands.
        socket.ev.emit = emitWithHistoryObserver;
        observingRawHistory = true;
      } else {
        // Compatibility with adapters that only expose subscription methods.
        socket.ev.on('messaging-history.set', onHistory);
        socket.ev.on('messages.upsert', onMessages);
      }
      socket.ev.on('connection.update', onConnection);
      let cursorKey = request.endKey;
      let cursorTimestamp = request.endTimestamp;
      while (reverseMessages.length < maxMessages) {
        let resolvePage;
        let rejectPage;
        const completed = new Promise((resolve, reject) => { resolvePage = resolve; rejectPage = reject; });
        completed.catch(() => {});
        const count = Math.min(MAX_PAGE_MESSAGES, maxMessages - reverseMessages.length);
        page = { id: undefined, requested: count, chunks: [], notifications: new Map(), unnumberedNotifications: 0, early: [], earlyNotifications: [], earlyBytes: 0, bytes: 0, count: 0, resolve: resolvePage, reject: rejectPage };
        pages++;
        const session = await Promise.race([
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw controller.signal.reason;
            return socket.fetchMessageHistory(count, cursorKey, cursorTimestamp);
          }),
          completed.then(() => { throw unavailable('WhatsApp returned history before its request was identified. Please try again.'); }),
          failure,
        ]);
        if (typeof session !== 'string' || !session) throw unavailable('WhatsApp did not identify the history request. Please try again.');
        page.id = session;
        const early = page.early;
        const earlyNotifications = page.earlyNotifications;
        page.early = [];
        page.earlyNotifications = [];
        page.earlyBytes = 0;
        for (const metadata of earlyNotifications) receiveNotification(metadata);
        for (const event of early) receiveForPage(event, event.metadata);
        await Promise.race([completed, failure]);
        clearTimeout(page.settleTimer);

        // Preserve protocol order for equal timestamps. Chunk numbers can restore
        // out-of-order delivery; otherwise retain the order supplied by Baileys.
        const chunks = page.chunks;
        if (chunks.length && chunks.every((chunk) => chunk.order != null)) {
          chunks.sort((a, b) => a.order - b.order || a.received - b.received);
        }
        let rows = chunks.flatMap((chunk) => chunk.rows);
        pageStats = snapshotPage();
        let cursorIndex = -1;
        let cursorIdPresent = false;
        for (let index = 0; index < rows.length; index++) {
          const key = rows[index].key;
          if (key.id !== cursorKey.id) continue;
          cursorIdPresent = true;
          if (key.fromMe === cursorKey.fromMe
            && await matchesVerifiedParticipant(key, cursorKey.participant)) {
            cursorIndex = index;
            break;
          }
        }
        if (cursorIdPresent && cursorIndex === -1) {
          throw unavailable('WhatsApp returned a history boundary whose sender could not be verified. Please try again with a new !summarise command.');
        }
        if (cursorIndex !== -1) rows = rows.slice(cursorIndex + 1);
        pageStats.cursorIndex = cursorIndex;
        pageStats.candidateRows = rows.length;

        let oldest;
        let previousTimestamp = cursorTimestamp;
        for (const message of rows) {
          if (message.key.id === request.endKey.id || seen.has(message.key.id)) continue;
          const timestamp = timestampSeconds(message.messageTimestamp);
          if (timestamp > previousTimestamp) {
            throw unavailable('WhatsApp returned history in an unexpected order. Please try again with a more recent starting message.');
          }
          previousTimestamp = timestamp;
          seen.add(message.key.id);
          reverseMessages.push(message);
          retainedBytes += byteLength(message);
          oldest = message;
          if (message.key.id === request.startId) {
            const anchorSenderMatches = request.startFromMe === true
              ? message.key.fromMe === true
              : (request.startFromMe !== false || message.key.fromMe === false)
                && await matchesVerifiedParticipant(message.key, request.startParticipant);
            if (anchorSenderMatches) {
              if (retries) diagnose('recovered_after_empty_page');
              return Object.freeze(reverseMessages.slice().reverse());
            }
            throw unavailable('WhatsApp returned the starting message but its sender could not be verified. Please try again with a new !summarise command.');
          }
          if (reverseMessages.length >= maxMessages) break;
        }
        if (!oldest) {
          if (pages === 1 && retries === 0 && pageStats.pageRows === 0) {
            retries = 1;
            diagnose('empty_page_retry');
            // Supersede this settled empty response. Late chunks from its
            // session are ignored; the retry asks for the same exact cursor.
            page = undefined;
            await Promise.race([
              new Promise(resolve => { retryTimer = setTimeout(resolve, emptyPageRetryMs); }),
              failure,
            ]);
            clearTimeout(retryTimer);
            retryTimer = undefined;
            continue;
          }
          throw missingAnchor(pageStats.pageRows === 0 ? 'empty_page' : 'no_progress',
            pageStats.pageRows === 0
              ? 'WhatsApp returned no earlier messages before reaching the starting message. Please try again with a new !summarise reply.'
              : 'WhatsApp returned history that did not move back to the starting message. Please try again with a new !summarise reply.');
        }
        cursorKey = { ...oldest.key };
        cursorTimestamp = timestampSeconds(oldest.messageTimestamp);
        page = undefined;
      }
      throw missingAnchor('limit_reached', 'I could not load the starting message within the configured history limit. Please reply to a more recent message.');
    } finally {
      clearTimeout(deadline);
      clearTimeout(retryTimer);
      clearTimeout(page?.settleTimer);
      controller.signal.removeEventListener('abort', abort);
      if (observingRawHistory) {
        if (socket.ev.emit === emitWithHistoryObserver) socket.ev.emit = originalEmit;
      } else {
        socket.ev.off('messaging-history.set', onHistory);
        socket.ev.off('messages.upsert', onMessages);
      }
      socket.ev.off('connection.update', onConnection);
      page = undefined;
      reverseMessages.length = 0;
      seen.clear();
    }
  }

  function startNext() {
    if (active || closed || !queue.length) return;
    const job = queue.shift();
    const controller = new AbortController();
    active = controller;
    run(job.request, controller).then(job.resolve, job.reject).finally(() => {
      active = undefined;
      startNext();
    });
  }

  return {
    load(options) {
      if (closed) return Promise.reject(unavailable('The WhatsApp history service is closed.'));
      let request;
      try { request = validateRequest(options); } catch (error) { return Promise.reject(error); }
      if (queue.length >= MAX_QUEUED_REQUESTS) return Promise.reject(unavailable('Too many summaries are waiting. Please try again shortly.'));
      return new Promise((resolve, reject) => {
        queue.push({ request, resolve, reject });
        startNext();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      const error = unavailable('The WhatsApp history service was closed. Please try again after it reconnects.');
      active?.abort(error);
      for (const job of queue.splice(0)) job.reject(error);
    },
  };
}
