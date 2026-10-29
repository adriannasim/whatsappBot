import { extractContent, messageTimestamp, normalizeJid } from './adapter.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\s\x00-\x1f\x7f]/.test(value);
const participants = key => [key?.participant, key?.participantAlt].map(normalizeJid).filter(Boolean);
const sameParticipant = (key, participant) => {
  const wanted = normalizeJid(participant);
  return Boolean(wanted && participants(key).includes(wanted));
};

function project(raw, groupId, timestamp) {
  const key = { remoteJid: groupId, id: raw.key.id, fromMe: raw.key.fromMe };
  for (const field of ['participant', 'participantAlt']) {
    const value = normalizeJid(raw.key[field] ?? (field === 'participant' ? raw.participant : undefined));
    if (value) key[field] = value;
  }
  const content = extractContent(raw);
  const row = { key, messageTimestamp: timestamp, message: {} };
  if (typeof raw.pushName === 'string') {
    row.pushName = Array.from(raw.pushName.replace(/[\x00-\x1f\x7f]/g, ' ').trim()).slice(0, 128).join('');
  }
  if (content.deleted) row.messageStubType = 1;
  else if (content.type === 'chat') row.message = { conversation: content.text };
  else if (['image', 'video', 'document'].includes(content.type)) row.message = { [`${content.type}Message`]: { caption: content.text } };
  else if (['audio', 'ptt'].includes(content.type)) row.message = { audioMessage: { ptt: content.type === 'ptt' } };
  else if (content.type === 'viewOnce') row.message = { viewOnceMessage: { message: {} } };
  else if (content.type === 'sticker') row.message = { stickerMessage: {} };
  else if (content.type === 'reaction') row.message = { reactionMessage: {} };
  return row;
}

function protocolKey(raw) {
  let message = raw?.message;
  for (let depth = 0; message && depth < 8; depth++) {
    const protocol = message.protocolMessage;
    if (protocol && [0, 14, 'REVOKE', 'MESSAGE_EDIT'].includes(protocol.type)) return protocol.key;
    message = (message.ephemeralMessage ?? message.documentWithCaptionMessage)?.message;
  }
  return undefined;
}

/** A bounded live-message window in RAM. No raw payloads or disk storage. */
export function createRecentMessageBuffer({
  groupIds,
  now = Date.now,
  ttlMs = DAY_MS,
  maxMessagesPerGroup = 3000,
  maxBytes = 32 * 1024 * 1024,
} = {}) {
  if (!(groupIds instanceof Set) && !Array.isArray(groupIds)) throw new TypeError('groupIds must be a Set or array.');
  const allowed = new Set(groupIds);
  if ([...allowed].some(id => typeof id !== 'string' || !/^[0-9-]+@g\.us$/.test(id))) throw new TypeError('groupIds must contain group JIDs.');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  for (const value of [ttlMs, maxMessagesPerGroup, maxBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Buffer limits must be positive integers.');
  }
  const groups = new Map();
  let bytes = 0;
  let sequence = 0;
  const sizeOf = row => Buffer.byteLength(JSON.stringify(row), 'utf8') + 128;

  function removePrefix(groupId, count) {
    const group = groups.get(groupId);
    if (!group) return;
    for (const entry of group.rows.splice(0, count)) {
      bytes -= entry.bytes;
      group.byId.delete(entry.row.key.id);
      entry.row.message = {};
      delete entry.row.pushName;
    }
    if (!group.rows.length) groups.delete(groupId);
  }

  function discardGroup(groupId) {
    removePrefix(groupId, groups.get(groupId)?.rows.length ?? 0);
  }

  function prune() {
    const current = now();
    for (const [groupId, group] of groups) {
      let lastExpired = -1;
      group.rows.forEach((entry, index) => {
        if (current >= entry.expiresAt) lastExpired = index;
      });
      // Removing a prefix also removes any earlier rows whose later neighbor
      // expired. A retained anchor can never straddle an eviction gap.
      if (lastExpired >= 0) removePrefix(groupId, lastExpired + 1);
    }
  }

  function matchesKey(stored, candidate) {
    if (candidate.fromMe !== undefined && candidate.fromMe !== stored.fromMe) return false;
    const aliases = participants(candidate);
    return !aliases.length || aliases.some(alias => sameParticipant(stored, alias));
  }

  function invalidate(keys) {
    prune();
    for (const key of Array.isArray(keys) ? keys : []) {
      if (!allowed.has(key?.remoteJid)) continue;
      const entry = groups.get(key.remoteJid)?.byId.get(key.id);
      if (!entry) continue;
      if (!matchesKey(entry.row.key, key)) {
        // Baileys can attach the deleting admin's sender to the target ID.
        // Uncertain identity must not leave deleted text available to the AI.
        discardGroup(key.remoteJid);
        continue;
      }
      bytes -= entry.bytes;
      entry.row.message = {};
      entry.row.messageStubType = 1;
      entry.bytes = sizeOf(entry.row);
      bytes += entry.bytes;
    }
    enforceBytes();
  }

  function enforceBytes() {
    while (bytes > maxBytes) {
      let oldest;
      for (const [groupId, group] of groups) {
        const entry = group.rows[0];
        if (!oldest || entry.sequence < oldest.entry.sequence) oldest = { groupId, entry };
      }
      if (!oldest) break;
      removePrefix(oldest.groupId, 1);
    }
  }

  function add(messages) {
    prune();
    for (const raw of Array.isArray(messages) ? messages : []) {
      const groupId = raw?.key?.remoteJid;
      if (!allowed.has(groupId)) continue;
      const target = protocolKey(raw);
      if (target) {
        if (!target.remoteJid || target.remoteJid === groupId) invalidate([{ ...target, remoteJid: groupId }]);
        continue;
      }
      if (raw.messageStubType === 1 || raw.messageStubType === 'REVOKE') {
        invalidate([raw.key]);
        continue;
      }
      const timestamp = messageTimestamp(raw);
      const receivedAt = now();
      const messageTime = timestamp * 1000;
      if (!validId(raw?.key?.id) || typeof raw.key.fromMe !== 'boolean'
        || !Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isFinite(receivedAt)
        || messageTime - receivedAt > MAX_CLOCK_SKEW_MS || receivedAt - messageTime >= ttlMs) {
        discardGroup(groupId);
        continue;
      }
      let group = groups.get(groupId);
      const existing = group?.byId.get(raw.key.id);
      if (existing) {
        if (!matchesKey(existing.row.key, raw.key) || existing.row.messageTimestamp !== timestamp) discardGroup(groupId);
        // A replay never overwrites text, resurrects a tombstone, or renews age.
        continue;
      }
      const previous = group?.rows.at(-1);
      if (previous && timestamp < previous.row.messageTimestamp) {
        // Arrival order is our only trustworthy order within one second. A
        // delayed older row invalidates coverage, rather than filling a gap.
        discardGroup(groupId);
        continue;
      }
      const row = project(raw, groupId, timestamp);
      const entry = { row, bytes: sizeOf(row), expiresAt: Math.min(receivedAt, messageTime) + ttlMs, sequence: sequence++ };
      if (entry.bytes > maxBytes) {
        discardGroup(groupId);
        continue;
      }
      if (!group) {
        group = { rows: [], byId: new Map() };
        groups.set(groupId, group);
      }
      group.rows.push(entry);
      group.byId.set(row.key.id, entry);
      bytes += entry.bytes;
      if (group.rows.length > maxMessagesPerGroup) removePrefix(groupId, group.rows.length - maxMessagesPerGroup);
      enforceBytes();
    }
  }

  function load(request = {}) {
    prune();
    const { groupId, startId, startParticipant, startFromMe, endKey, endTimestamp } = request;
    if (!allowed.has(groupId) || !validId(startId) || !validId(endKey?.id)
      || endKey.remoteJid !== groupId || typeof endKey.fromMe !== 'boolean') return null;
    const group = groups.get(groupId);
    if (!group) return null;
    const start = group.byId.get(startId);
    const end = group.byId.get(endKey.id);
    if (!start || !end || start.sequence >= end.sequence || !matchesKey(end.row.key, endKey)
      || end.row.messageTimestamp !== messageTimestamp({ messageTimestamp: endTimestamp })) return null;
    if (endKey.fromMe === false && !participants(endKey).some(alias => sameParticipant(end.row.key, alias))) return null;
    if (startFromMe !== undefined && startFromMe !== start.row.key.fromMe) return null;
    if (startFromMe !== true && !sameParticipant(start.row.key, startParticipant)) return null;
    const rows = group.rows.filter(entry => entry.sequence >= start.sequence && entry.sequence < end.sequence);
    return rows.map(entry => structuredClone(entry.row));
  }

  function clear() {
    for (const groupId of groups.keys()) discardGroup(groupId);
    bytes = 0;
  }

  return { add, load, prune, clear, invalidate, discardGroup };
}
