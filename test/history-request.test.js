import test from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { requestHistoryPage } from '../src/history-request.js';
import { HistoryUnavailableError } from '../src/history-error.js';

const SECONDS = 1_793_282_400;
const cursor = fromMe => ({
  remoteJid: '123456-789@g.us', id: 'exact-cursor-id', fromMe,
  participant: '456@lid', participantAlt: '789@s.whatsapp.net',
});

test('real socket history requests preserve protobuf cursor fields and include native peer attributes', async () => {
  for (const fromMe of [false, true]) {
    const key = Object.freeze(cursor(fromMe));
    let called = 0;
    const socket = {
      user: { id: '999:8@s.whatsapp.net', lid: '111:8@lid' },
      fetchMessageHistory() { assert.fail('Do not omit the privacy attribute through the old helper'); },
      sendMessage() { assert.fail('History uses a peer protocol request, not an ordinary chat message'); },
      async relayMessage(destination, content, options) {
        called++;
        assert.equal(this, socket);
        assert.equal(destination, '999@s.whatsapp.net');
        assert.deepEqual(options, {
          additionalAttributes: { category: 'peer', push_priority: 'high_force', privacy_sensitive: '1' },
          additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }],
        });
        const decoded = proto.Message.decode(proto.Message.encode(content).finish());
        assert.equal(decoded.protocolMessage.type, proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE);
        const operation = decoded.protocolMessage.peerDataOperationRequestMessage;
        assert.equal(operation.peerDataOperationRequestType, proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND);
        const request = operation.historySyncOnDemandRequest;
        assert.equal(request.chatJid, key.remoteJid);
        assert.equal(request.oldestMsgId, key.id);
        assert.equal(request.oldestMsgFromMe, fromMe);
        assert.equal(request.oldestMsgTimestampMs.toNumber(), SECONDS);
        assert.equal(request.onDemandMsgCount, 50);
        assert.equal(request.accountLid, null);
        return 'unchanged-request-session-id';
      },
    };
    assert.equal(await requestHistoryPage(socket, 50, key, SECONDS), 'unchanged-request-session-id');
    assert.equal(called, 1);
    assert.deepEqual(key, cursor(fromMe));
  }
});

test('auth-state identity is supported when a custom relay adapter has no user getter', async () => {
  const socket = {
    authState: { creds: { me: { id: '999:4@s.whatsapp.net' } } },
    async relayMessage(destination) {
      assert.equal(destination, '999@s.whatsapp.net');
      return 'session';
    },
  };
  assert.equal(await requestHistoryPage(socket, 1, cursor(false), SECONDS), 'session');
});

test('current authentication identity takes precedence over a stale outer user snapshot', async () => {
  const socket = {
    user: { id: '111:7@s.whatsapp.net' },
    authState: { creds: { me: { id: '999:4@s.whatsapp.net' } } },
    async relayMessage(destination) {
      assert.equal(destination, '999@s.whatsapp.net');
      return 'current-identity-session';
    },
  };
  assert.equal(await requestHistoryPage(socket, 1, cursor(false), SECONDS), 'current-identity-session');
});

test('an unauthenticated relay socket fails safely without falling back to the incomplete envelope', async () => {
  for (const user of [undefined, {}, { id: '' }, { id: 'invalid' }]) {
    const socket = {
      user,
      relayMessage() { assert.fail('Cannot relay without an authenticated own identity'); },
      fetchMessageHistory() { assert.fail('Cannot silently use the envelope missing privacy_sensitive'); },
    };
    await assert.rejects(requestHistoryPage(socket, 50, cursor(false), SECONDS), error => {
      assert.ok(error instanceof HistoryUnavailableError);
      assert.equal(error.code, 'HISTORY_UNAVAILABLE');
      assert.match(error.message, /not authenticated/);
      return true;
    });
  }
});

test('a relay failure propagates unchanged without sending a second request', async () => {
  const failure = new Error('Synthetic relay failure');
  const socket = {
    user: { id: '999@s.whatsapp.net' },
    async relayMessage() { throw failure; },
    fetchMessageHistory() { assert.fail('A failed real relay must not trigger legacy fallback'); },
  };
  await assert.rejects(requestHistoryPage(socket, 10, cursor(false), SECONDS), error => error === failure);
});

test('custom adapters without relayMessage retain their existing history method and arguments', async () => {
  const key = cursor(true);
  const socket = {
    async fetchMessageHistory(count, receivedKey, timestamp) {
      assert.equal(this, socket);
      assert.equal(count, 7);
      assert.equal(receivedKey, key);
      assert.equal(timestamp, SECONDS);
      return 'adapter-session';
    },
  };
  assert.equal(await requestHistoryPage(socket, 7, key, SECONDS), 'adapter-session');
});

test('a socket without either history transport reports unavailable', async () => {
  await assert.rejects(requestHistoryPage({}, 1, cursor(false), SECONDS), { code: 'HISTORY_UNAVAILABLE' });
});
