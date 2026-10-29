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

/** Bounded projected messages. The caller owns persistence of detached snapshots. */
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
  let nextSegment = 1;
  // Negative segment IDs are unordered replay batches. Positive IDs are live
  // stretches; overlap discovered through replay can make those uncertain too.
  const uncertainSegments = new Set();
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
    const retainedSegments = new Set([...groups.values()].flatMap(group => group.rows.map(entry => entry.segment)));
    for (const segment of uncertainSegments) if (!retainedSegments.has(segment)) uncertainSegments.delete(segment);
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

  function addRows(messages, replay) {
    prune();
    const replaySegments = new Map();
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
      // Old replay rows are outside this retained window, so they cannot make
      // a hole inside it. Live input keeps the stricter continuity check.
      if (replay && Number.isSafeInteger(timestamp) && receivedAt - messageTime >= ttlMs) continue;
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
      const previous = !replay && group?.liveSegment !== undefined
        ? group.rows.findLast(entry => entry.segment === group.liveSegment) : undefined;
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
      if (replay) {
        if (!replaySegments.has(groupId)) replaySegments.set(groupId, -(nextSegment++));
        entry.segment = replaySegments.get(groupId);
        const ranges = new Map();
        for (const existingEntry of group.rows) {
          if (existingEntry.segment < 0) continue;
          const time = existingEntry.row.messageTimestamp;
          const range = ranges.get(existingEntry.segment) ?? [time, time];
          ranges.set(existingEntry.segment, [Math.min(range[0], time), Math.max(range[1], time)]);
        }
        for (const [segment, [first, last]] of ranges) {
          if (timestamp >= first && timestamp <= last) uncertainSegments.add(segment);
        }
      } else {
        group.liveSegment ??= nextSegment++;
        entry.segment = group.liveSegment;
      }
      group.rows.push(entry);
      group.byId.set(row.key.id, entry);
      bytes += entry.bytes;
      if (group.rows.length > maxMessagesPerGroup) removePrefix(groupId, group.rows.length - maxMessagesPerGroup);
      enforceBytes();
    }
  }

  function boundaries(request = {}) {
    const { groupId, startId, startParticipant, startFromMe, endKey, endTimestamp } = request;
    if (!allowed.has(groupId) || !validId(startId) || !validId(endKey?.id)
      || endKey.remoteJid !== groupId || typeof endKey.fromMe !== 'boolean') return null;
    const group = groups.get(groupId);
    if (!group) return null;
    const start = group.byId.get(startId);
    const end = group.byId.get(endKey.id);
    if (!start || !end || start === end || start.row.messageTimestamp > end.row.messageTimestamp
      || (start.segment === end.segment && start.segment > 0 && start.sequence >= end.sequence)
      || !matchesKey(end.row.key, endKey)
      || end.row.messageTimestamp !== messageTimestamp({ messageTimestamp: endTimestamp })) return null;
    if (endKey.fromMe === false && !participants(endKey).some(alias => sameParticipant(end.row.key, alias))) return null;
    if (startFromMe !== undefined && startFromMe !== start.row.key.fromMe) return null;
    if (startFromMe !== true && !sameParticipant(start.row.key, startParticipant)) return null;
    return { group, start, end };
  }

  function strictRows(boundary) {
    if (!boundary) return null;
    const { group, start, end } = boundary;
    if (start.segment !== end.segment || start.segment < 0 || uncertainSegments.has(start.segment)) return null;
    const rows = group.rows.filter(entry => entry.sequence >= start.sequence && entry.sequence < end.sequence);
    if (rows.some(entry => entry.segment !== start.segment)) return null;
    return rows;
  }

  function load(request = {}) {
    prune();
    return strictRows(boundaries(request))?.map(entry => structuredClone(entry.row)) ?? null;
  }

  function loadAvailable(request = {}) {
    prune();
    const boundary = boundaries(request);
    if (!boundary) return null;
    const strict = strictRows(boundary);
    if (strict) return { messages: strict.map(entry => structuredClone(entry.row)), gapCount: 0 };
    const { group, start, end } = boundary;
    const firstTime = start.row.messageTimestamp;
    const lastTime = end.row.messageTimestamp;
    const rows = group.rows.filter(entry => {
      if (entry === start) return true;
      if (entry === end) return false;
      const time = entry.row.messageTimestamp;
      if (time < firstTime || time > lastTime) return false;
      if (entry.segment === start.segment && entry.segment > 0 && entry.sequence < start.sequence) return false;
      if (entry.segment === end.segment && entry.segment > 0 && entry.sequence >= end.sequence) return false;
      if (time === firstTime || time === lastTime) {
        // Seconds alone cannot place another segment's message relative to
        // either boundary. Only known live order or the exact quoted anchor
        // can establish its position within that same second.
        return entry.segment > 0 && (entry.segment === start.segment || entry.segment === end.segment)
          && entry.sequence >= start.sequence && entry.sequence < end.sequence;
      }
      return true;
    });
    rows.sort((left, right) => left.row.messageTimestamp - right.row.messageTimestamp
      || (left === start ? -1 : right === start ? 1 : left.sequence - right.sequence));
    const segments = new Set([start.segment, end.segment, ...rows.map(entry => entry.segment)]);
    return { messages: rows.map(entry => structuredClone(entry.row)), gapCount: Math.max(1, segments.size - 1) };
  }

  function markGap() {
    for (const group of groups.values()) group.liveSegment = undefined;
  }

  function has(key) {
    prune();
    if (!allowed.has(key?.remoteJid)) return false;
    const entry = groups.get(key.remoteJid)?.byId.get(key.id);
    return Boolean(entry && matchesKey(entry.row.key, key));
  }

  function checkpoint(groupId) {
    prune();
    let latest;
    for (const entry of groups.get(groupId)?.rows ?? []) {
      if (!latest || entry.row.messageTimestamp > latest.row.messageTimestamp
        || (entry.row.messageTimestamp === latest.row.messageTimestamp && entry.sequence > latest.sequence)) latest = entry;
    }
    return latest ? { key: { ...latest.row.key }, messageTimestamp: latest.row.messageTimestamp } : null;
  }

  function snapshot() {
    prune();
    const entries = [...groups.values()].flatMap(group => group.rows).sort((a, b) => a.sequence - b.sequence)
      .map(({ row, expiresAt, sequence: order, segment }) => ({ row: structuredClone(row), expiresAt, sequence: order, segment }));
    const latestByGroup = new Map();
    for (const entry of entries) {
      const groupId = entry.row.key.remoteJid;
      const latest = latestByGroup.get(groupId);
      if (!latest || entry.row.messageTimestamp >= latest.row.messageTimestamp) latestByGroup.set(groupId, entry);
    }
    const cutoffs = [...latestByGroup].map(([groupId, entry]) => ({ groupId,
      key: { ...entry.row.key }, messageTimestamp: entry.row.messageTimestamp }));
    return { version: 1, entries, uncertainSegments: [...uncertainSegments], cutoffs };
  }

  function restore(saved) {
    // Validate the entire snapshot before exposing any of it. Persisted files
    // are inputs, not trusted raw WhatsApp payloads or executable objects.
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1_000_000;
    const fail = () => { throw new Error('Invalid recent-message snapshot.'); };
    const fields = (value, names) => object(value) && Object.keys(value).every(name => names.includes(name));
    const empty = value => object(value) && Object.keys(value).length === 0;
    function projectedMessage(message) {
      if (!object(message)) return false;
      const names = Object.keys(message);
      if (names.length === 0) return true;
      if (names.length !== 1) return false;
      const name = names[0];
      const payload = message[name];
      if (name === 'conversation') return typeof payload === 'string' && payload.length <= maxBytes;
      if (['imageMessage', 'videoMessage', 'documentMessage'].includes(name)) {
        return fields(payload, ['caption']) && typeof payload.caption === 'string' && payload.caption.length <= maxBytes;
      }
      if (name === 'audioMessage') return fields(payload, ['ptt']) && typeof payload.ptt === 'boolean';
      if (name === 'viewOnceMessage') return fields(payload, ['message']) && empty(payload.message);
      return ['stickerMessage', 'reactionMessage'].includes(name) && empty(payload);
    }
    try {
      if (!fields(saved, ['version', 'entries', 'uncertainSegments', 'cutoffs']) || saved.version !== 1 || !Array.isArray(saved.entries)
        || saved.entries.length > Math.floor(maxBytes / 128)
        || !Array.isArray(saved.uncertainSegments ?? []) || (saved.uncertainSegments?.length ?? 0) > saved.entries.length) fail();
      const staged = [];
      const identities = new Set();
      const seenSegments = new Set();
      let previousSequence = -1;
      let projectedBytes = 0;
      const current = now();
      for (const item of saved.entries) {
        const raw = item?.row;
        const key = raw?.key;
        const timestamp = raw?.messageTimestamp;
        if (!fields(item, ['row', 'expiresAt', 'sequence', 'segment'])
          || !fields(raw, ['key', 'messageTimestamp', 'message', 'pushName', 'messageStubType'])
          || !fields(key, ['remoteJid', 'id', 'fromMe', 'participant', 'participantAlt']) || !projectedMessage(raw.message)
          || typeof key.remoteJid !== 'string' || !/^[0-9-]+@g\.us$/.test(key.remoteJid)
          || key.remoteJid.length > 256 || !validId(key.id) || typeof key.fromMe !== 'boolean'
          || !integer(timestamp) || timestamp <= 0 || timestamp * 1000 - current > MAX_CLOCK_SKEW_MS
          || !integer(item.expiresAt) || !integer(item.sequence) || item.sequence <= previousSequence
          || !Number.isSafeInteger(item.segment) || item.segment === 0 || !integer(Math.abs(item.segment))) fail();
        for (const field of ['participant', 'participantAlt']) {
          if (key[field] !== undefined && (typeof key[field] !== 'string' || !normalizeJid(key[field]))) fail();
        }
        if (raw.pushName !== undefined && (typeof raw.pushName !== 'string' || raw.pushName.length > 256)) fail();
        if (raw.messageStubType !== undefined && raw.messageStubType !== 1) fail();
        const identity = JSON.stringify([key.remoteJid, key.id]);
        if (identities.has(identity)) fail();
        identities.add(identity);
        previousSequence = item.sequence;
        seenSegments.add(item.segment);
        const content = extractContent(raw);
        if (typeof content.text !== 'string' || content.text.length > maxBytes) fail();
        const row = project(raw, key.remoteJid, timestamp);
        const size = sizeOf(row);
        projectedBytes += size;
        // A valid snapshot fits the same global envelope; fail closed rather
        // than accepting an unbounded input and hoping later eviction helps.
        if (projectedBytes > maxBytes) fail();
        staged.push({ row, bytes: size, sequence: item.sequence, segment: item.segment,
          expiresAt: Math.min(item.expiresAt, timestamp * 1000 + ttlMs, current + ttlMs) });
      }
      const uncertain = saved.uncertainSegments ?? [];
      if (new Set(uncertain).size !== uncertain.length
        || uncertain.some(segment => !Number.isSafeInteger(segment) || segment <= 0 || !seenSegments.has(segment))) fail();
      if (saved.cutoffs !== undefined) {
        if (!Array.isArray(saved.cutoffs) || saved.cutoffs.length > staged.length) fail();
        const cutoffGroups = new Set();
        for (const cutoff of saved.cutoffs) {
          if (!fields(cutoff, ['groupId', 'key', 'messageTimestamp']) || !object(cutoff.key)
            || cutoff.groupId !== cutoff.key.remoteJid || cutoffGroups.has(cutoff.groupId)) fail();
          cutoffGroups.add(cutoff.groupId);
          const entry = staged.find(item => item.row.key.remoteJid === cutoff.groupId && item.row.key.id === cutoff.key.id);
          if (!entry || cutoff.messageTimestamp !== entry.row.messageTimestamp
            || JSON.stringify(cutoff.key) !== JSON.stringify(entry.row.key)) fail();
        }
      }
      // One segment belongs to one group and has a single chronological live
      // stretch. An invalid ordering cannot be upgraded into complete history.
      const segmentOwners = new Map();
      for (const entry of staged) {
        const owner = segmentOwners.get(entry.segment);
        if (owner && (owner.groupId !== entry.row.key.remoteJid
          || (entry.segment > 0 && entry.row.messageTimestamp < owner.timestamp))) fail();
        segmentOwners.set(entry.segment, { groupId: entry.row.key.remoteJid, timestamp: entry.row.messageTimestamp });
      }
      clear();
      for (const entry of staged) {
        const groupId = entry.row.key.remoteJid;
        if (!allowed.has(groupId)) continue;
        let group = groups.get(groupId);
        if (!group) { group = { rows: [], byId: new Map() }; groups.set(groupId, group); }
        group.rows.push(entry);
        group.byId.set(entry.row.key.id, entry);
        bytes += entry.bytes;
        sequence = Math.max(sequence, entry.sequence + 1);
        nextSegment = Math.max(nextSegment, Math.abs(entry.segment) + 1);
        if (group.rows.length > maxMessagesPerGroup) removePrefix(groupId, group.rows.length - maxMessagesPerGroup);
      }
      for (const segment of uncertain) uncertainSegments.add(segment);
      prune();
      enforceBytes();
      markGap();
    } catch {
      clear();
      throw new Error('Invalid recent-message snapshot.');
    }
  }

  function clear() {
    for (const groupId of groups.keys()) discardGroup(groupId);
    bytes = 0;
    sequence = 0;
    nextSegment = 1;
    uncertainSegments.clear();
  }

  return { add: messages => addRows(messages, false), addReplay: messages => addRows(messages, true),
    load, loadAvailable, prune, clear, invalidate, discardGroup, markGap, has, checkpoint, snapshot, restore };
}
