import { jidNormalizedUser, proto } from '@whiskeysockets/baileys';
import { HistoryUnavailableError } from './history-error.js';

/** Send one validated history page request without changing ordinary messages. */
export async function requestHistoryPage(socket, count, key, timestampSeconds) {
  // Custom adapters may expose only the high-level history method. Real
  // Baileys sockets expose relayMessage, so always use the complete peer
  // envelope there, including the history-specific privacy attribute.
  if (typeof socket?.relayMessage !== 'function') {
    if (typeof socket?.fetchMessageHistory !== 'function') {
      throw new HistoryUnavailableError('WhatsApp is not connected. Please try again after it reconnects.');
    }
    return socket.fetchMessageHistory(count, key, timestampSeconds);
  }

  const ownId = socket.authState?.creds?.me?.id ?? socket.user?.id;
  const ownJid = typeof ownId === 'string' ? jidNormalizedUser(ownId) : '';
  if (!ownJid) {
    throw new HistoryUnavailableError('WhatsApp is not authenticated. Please reconnect the bot account.');
  }

  // Match Baileys rc14's peer envelope, plus the native history attribute:
  // https://github.com/tulir/whatsmeow/commit/54650307d891f89ab346a57953d316106caee371
  // https://github.com/tulir/whatsmeow/commit/015cd4020f7ab1afacd13ab437b5afcc138f6195
  return socket.relayMessage(ownJid, {
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE,
      peerDataOperationRequestMessage: {
        peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
        historySyncOnDemandRequest: {
          chatJid: key.remoteJid,
          oldestMsgFromMe: key.fromMe,
          oldestMsgId: key.id,
          oldestMsgTimestampMs: timestampSeconds,
          onDemandMsgCount: count,
        },
      },
    },
  }, {
    additionalAttributes: { category: 'peer', push_priority: 'high_force', privacy_sensitive: '1' },
    additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }],
  });
}
