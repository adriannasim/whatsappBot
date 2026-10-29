import { chmod, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeJid } from './adapter.js';

async function loadBaileys() {
  const [baileys, { default: pino }] = await Promise.all([
    import('@whiskeysockets/baileys'), import('pino'),
  ]);
  return {
    makeSocket: baileys.default,
    useAuthState: baileys.useMultiFileAuthState,
    cacheKeys: baileys.makeCacheableSignalKeyStore,
    reasons: baileys.DisconnectReason,
    onDemandType: baileys.proto.HistorySync.HistorySyncType.ON_DEMAND,
    logger: pino({ level: 'silent' }),
  };
}

const NOOP = () => {};

/** One Baileys connection, with live and recovered messages routed separately. */
export function createWhatsAppConnection({
  authDir = './.baileys-auth',
  onMessages = NOOP,
  onReplayMessages = NOOP,
  onMessageChanges = NOOP,
  onChatMessagesDeleted = NOOP,
  onOpen = NOOP,
  onQR = NOOP,
  onDisconnect = NOOP,
  onFatal = NOOP,
  log = NOOP,
  getMessage = async () => undefined,
  loadDependencies = loadBaileys,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  maxReconnectAttempts = 10,
  reconnectBaseMs = 1000,
  reconnectMaxMs = 30_000,
} = {}) {
  if (typeof authDir !== 'string' || !authDir.trim()) throw new TypeError('WA_AUTH_DIR must be a directory path.');
  for (const callback of [onMessages, onReplayMessages, onMessageChanges, onChatMessagesDeleted, onOpen, onQR, onDisconnect, onFatal, log, getMessage, loadDependencies, setTimeoutImpl, clearTimeoutImpl]) {
    if (typeof callback !== 'function') throw new TypeError('Connection callbacks must be functions.');
  }
  if (!Number.isSafeInteger(maxReconnectAttempts) || maxReconnectAttempts < 0
    || !Number.isSafeInteger(reconnectBaseMs) || reconnectBaseMs < 1
    || !Number.isSafeInteger(reconnectMaxMs) || reconnectMaxMs < reconnectBaseMs) {
    throw new TypeError('Invalid reconnect limits.');
  }

  const directory = path.resolve(authDir);
  let deps;
  let auth;
  let current;
  let cleanup;
  let generation = 0;
  let stopped = false;
  let failed = false;
  let starting;
  let stopping;
  let reconnectTimer;
  let reconnectAttempts = 0;
  let credentialWrites = Promise.resolve();
  const closing = new Set();

  function note(message) {
    try { log(message); } catch { /* Logging cannot change connection state. */ }
  }

  function invoke(callback, args, failureMessage) {
    try {
      Promise.resolve(callback(...args)).catch(() => note(failureMessage));
    } catch { note(failureMessage); }
  }

  function clearReconnect() {
    if (reconnectTimer !== undefined) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function retireSocket() {
    const socket = current;
    current = undefined;
    generation++;
    cleanup?.();
    cleanup = undefined;
    if (!socket) return;
    // end closes this local transport; logout would revoke the linked device.
    const closed = Promise.resolve().then(() => socket.end?.(new Error('Local connection closed'))).catch(() => {});
    closing.add(closed);
    closed.finally(() => closing.delete(closed));
  }

  function fail(code) {
    if (stopped || failed) return;
    failed = true;
    clearReconnect();
    retireSocket();
    invoke(onFatal, [code], 'Could not report the WhatsApp connection failure.');
  }

  function queueCredentialSave() {
    credentialWrites = credentialWrites.then(() => auth.saveCreds()).catch(() => {
      fail('WHATSAPP_AUTH_SAVE_FAILED');
    });
  }

  function scheduleReconnect(reason) {
    if (stopped || failed || reconnectTimer !== undefined) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
      fail('WHATSAPP_RECONNECT_FAILED');
      return;
    }
    const attempt = reconnectAttempts++;
    const delay = reason === deps.reasons.restartRequired
      ? Math.min(reconnectBaseMs, 500)
      : Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** Math.min(attempt, 20));
    note(`WhatsApp disconnected. Reconnecting in ${Math.ceil(delay / 1000)} second(s).`);
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = undefined;
      void connect().catch(() => scheduleReconnect());
    }, delay);
  }

  async function connect() {
    await credentialWrites;
    await Promise.allSettled([...closing]);
    if (stopped || failed) return;
    const socket = deps.makeSocket({
      auth: {
        creds: auth.state.creds,
        keys: deps.cacheKeys(auth.state.keys, deps.logger),
      },
      logger: deps.logger,
      syncFullHistory: false,
      enableRecentMessageCache: false,
      shouldSyncHistoryMessage: notification => notification?.syncType === deps.onDemandType,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      connectTimeoutMs: 30_000,
      getMessage: async key => {
        try { return await getMessage(key); }
        catch { return undefined; }
      },
    });
    if (!socket?.ev || typeof socket.ev.on !== 'function' || typeof socket.ev.off !== 'function') {
      throw new Error('The WhatsApp connection could not be created.');
    }
    current = socket;
    const identity = ++generation;
    const active = () => !stopped && !failed && current === socket && generation === identity;

    const credentials = () => { if (active()) queueCredentialSave(); };
    const messages = event => {
      if (!active() || !Array.isArray(event?.messages)) return;
      if (event.type === 'append' || (event.type === 'notify' && event.requestId != null)) {
        invoke(onReplayMessages, [event.messages], 'Could not collect recovered WhatsApp messages.');
      } else if (event.type === 'notify') {
        invoke(onMessages, [event.messages], 'Could not process an incoming WhatsApp command.');
      }
    };
    const messageUpdates = updates => {
      if (!active() || !Array.isArray(updates)) return;
      // Receipt/status updates do not change text. Edits and revokes do:
      // erase their old content instead of summarizing a stale retained copy.
      const keys = updates.filter(item => item?.update && (
        Object.hasOwn(item.update, 'message')
        || item.update.messageStubType === 1 || item.update.messageStubType === 'REVOKE'
      )).map(item => item.key).filter(Boolean);
      if (keys.length) invoke(onMessageChanges, [keys], 'Could not clear changed message content.');
    };
    const messageDeletes = event => {
      if (!active()) return;
      if (event?.all === true && typeof event.jid === 'string') {
        invoke(onChatMessagesDeleted, [event.jid], 'Could not clear deleted chat messages.');
      } else if (Array.isArray(event?.keys)) {
        invoke(onMessageChanges, [event.keys], 'Could not clear deleted message content.');
      }
    };
    const connection = update => {
      if (!active()) return;
      if (typeof update?.qr === 'string' && update.qr) invoke(onQR, [update.qr], 'Could not display the WhatsApp pairing QR.');
      if (update?.connection === 'open') {
        reconnectAttempts = 0;
        invoke(onOpen, [socket], 'Could not complete WhatsApp connection setup.');
      }
      if (update?.connection !== 'close') return;
      const status = update.lastDisconnect?.error?.output?.statusCode
        ?? update.lastDisconnect?.error?.statusCode;
      retireSocket();
      invoke(onDisconnect, [], 'Could not complete WhatsApp disconnect cleanup.');
      const fatal = new Map([
        [deps.reasons.loggedOut, 'WHATSAPP_LOGGED_OUT'],
        [deps.reasons.badSession, 'WHATSAPP_SESSION_INVALID'],
        [deps.reasons.connectionReplaced, 'WHATSAPP_CONNECTION_REPLACED'],
        [deps.reasons.forbidden, 'WHATSAPP_FORBIDDEN'],
        [deps.reasons.multideviceMismatch, 'WHATSAPP_SESSION_INVALID'],
      ]).get(status);
      if (fatal) fail(fatal);
      else scheduleReconnect(status);
    };
    socket.ev.on('creds.update', credentials);
    socket.ev.on('messages.upsert', messages);
    socket.ev.on('messages.update', messageUpdates);
    socket.ev.on('messages.delete', messageDeletes);
    socket.ev.on('connection.update', connection);
    cleanup = () => {
      socket.ev.off('creds.update', credentials);
      socket.ev.off('messages.upsert', messages);
      socket.ev.off('messages.update', messageUpdates);
      socket.ev.off('messages.delete', messageDeletes);
      socket.ev.off('connection.update', connection);
    };
  }

  function start() {
    if (stopped || failed) return Promise.reject(new Error('This WhatsApp connection has stopped. Create a new connection to restart.'));
    if (starting) return starting;
    starting = (async () => {
      try {
        process.umask(0o077);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid authentication directory');
        await chmod(directory, 0o700);
        if (stopped) return;
        deps = await loadDependencies();
        if (stopped) return;
        auth = await deps.useAuthState(directory);
        if (stopped) return;
        await connect();
      } catch {
        if (stopped) return;
        fail('WHATSAPP_START_FAILED');
        throw Object.assign(new Error('Could not start WhatsApp. Check the Baileys installation and private authentication directory.'), { code: 'WHATSAPP_START_FAILED' });
      }
    })();
    return starting;
  }

  function stop() {
    if (stopping) return stopping;
    stopped = true;
    clearReconnect();
    retireSocket();
    stopping = (async () => {
      await starting?.catch(() => {});
      await credentialWrites;
      await Promise.allSettled([...closing]);
    })();
    return stopping;
  }

  function getOwnIds() {
    const ids = [current?.user?.id, current?.user?.lid, auth?.state?.creds?.me?.id, auth?.state?.creds?.me?.lid];
    return [...new Set(ids.map(normalizeJid).filter(Boolean))];
  }

  return { start, stop, getSocket: () => current, getOwnIds };
}
