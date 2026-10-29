import { isSummariseCommand } from './service.js';
import { getGreetingKind } from './greetings.js';

const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyContent = (type = 'unknown', deleted = false) => ({ text: '', type, contextInfo: undefined, deleted });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
const isGroup = value => typeof value === 'string' && /^[0-9-]+@g\.us$/.test(value);

/** Remove multi-device suffixes; PN and LID are separate identities unless supplied as aliases. */
export function normalizeJid(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) return '';
  const match = /^([^@]+)@([^@]+)$/.exec(value);
  if (!match) return '';
  const user = match[1].split(':', 1)[0].split('_', 1)[0];
  const server = match[2] === 'c.us' ? 's.whatsapp.net' : match[2];
  if (!user || !['s.whatsapp.net', 'lid', 'g.us', 'hosted', 'hosted.lid'].includes(server)) return '';
  return `${user}@${server}`;
}

export function sameUser(left, right) {
  const normalized = normalizeJid(left);
  return Boolean(normalized && normalized === normalizeJid(right));
}

/** Baileys messageTimestamp is Unix seconds and can be a protobuf Long. */
export function messageTimestamp(raw) {
  const value = raw?.messageTimestamp;
  let seconds;
  try {
    seconds = typeof value === 'number' ? value
      : typeof value === 'bigint' ? Number(value)
        : typeof value === 'string' && /^\d+$/.test(value) ? Number(value)
          : typeof value?.toNumber === 'function' ? value.toNumber()
            : Number.isInteger(value?.low) && Number.isInteger(value?.high)
              ? Number((BigInt(value.high) << 32n) + BigInt(value.low >>> 0)) : NaN;
  } catch { return NaN; }
  return Number.isSafeInteger(seconds) && seconds >= 0
    && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : NaN;
}

/** Extract supported visible text without downloading media or executing message actions. */
export function extractContent(raw) {
  if (!ownObject(raw)) return emptyContent();
  // REVOKE is WebMessageInfo.StubType.REVOKE in the pinned Baileys protobuf.
  if (raw.messageStubType === 1 || raw.messageStubType === 'REVOKE') return emptyContent('revoked', true);
  let content = ownObject(raw.message) ? raw.message : raw;
  for (let depth = 0; depth < 8; depth++) {
    if (!ownObject(content)) return emptyContent();
    if (content.protocolMessage || content.editedMessage) {
      const protocol = content.protocolMessage;
      const revoked = protocol?.type === 0 || protocol?.type === 'REVOKE';
      return emptyContent(revoked ? 'revoked' : 'protocol', revoked);
    }
    // View-once media is intentionally not expanded into the summary transcript.
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension) {
      return emptyContent('viewOnce');
    }
    const wrapper = content.ephemeralMessage || content.documentWithCaptionMessage;
    if (wrapper) {
      content = wrapper.message;
      continue;
    }
    const result = (text, type, contextInfo) => ({
      text: typeof text === 'string' ? text : '', type,
      contextInfo: ownObject(contextInfo) ? contextInfo : undefined, deleted: false,
    });
    if (typeof content.conversation === 'string') return result(content.conversation, 'chat');
    if (ownObject(content.extendedTextMessage)) {
      const message = content.extendedTextMessage;
      return result(message.text, 'chat', message.contextInfo);
    }
    for (const [key, type] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['documentMessage', 'document']]) {
      if (ownObject(content[key])) return result(content[key].caption, type, content[key].contextInfo);
    }
    if (content.audioMessage) return emptyContent(content.audioMessage.ptt ? 'ptt' : 'audio');
    if (content.stickerMessage) return emptyContent('sticker');
    if (content.reactionMessage) return emptyContent('reaction');
    return emptyContent();
  }
  return emptyContent();
}

function ownSet(ownIds) {
  return new Set((Array.isArray(ownIds) ? ownIds : [ownIds]).map(normalizeJid).filter(Boolean));
}

function senderIds(raw) {
  return [raw?.key?.participant, raw?.key?.participantAlt, raw?.participant].map(normalizeJid).filter(Boolean);
}

function fromBot(raw, own) {
  return raw?.key?.fromMe === true || senderIds(raw).some(id => own.has(id));
}

/** Only the live notify handler should call this; history events are never commands. */
export function getIncomingCommand(raw, ownIds = []) {
  const groupId = raw?.key?.remoteJid;
  const id = raw?.key?.id;
  const timestamp = messageTimestamp(raw);
  if (!isGroup(groupId) || !validId(id) || !Number.isFinite(timestamp)) return null;
  const own = ownSet(ownIds);
  if (fromBot(raw, own)) return null;
  const content = extractContent(raw);
  if (content.deleted) return null;
  const kind = isSummariseCommand(content.text) ? 'summarise' : getGreetingKind(content.text);
  if (!kind) return null;
  const senderJid = senderIds(raw).find(jid => /^\d+@(s\.whatsapp\.net|lid)$/.test(jid));
  if (kind !== 'summarise' && !senderJid) return null;
  const context = content.contextInfo;
  const mentioned = Array.isArray(context?.mentionedJid)
    && context.mentionedJid.some(jid => own.has(normalizeJid(jid)));
  const sameChat = !context?.remoteJid || context.remoteJid === groupId;
  const quotedId = sameChat && validId(context?.stanzaId) ? context.stanzaId : null;
  const quotedParticipant = quotedId ? normalizeJid(context?.participant) || undefined : undefined;
  return {
    kind,
    ...(kind !== 'summarise' ? { senderJid } : {}),
    command: { id, groupId, text: content.text, timestamp, fromBot: false },
    mentioned, quotedId, quotedParticipant, raw,
  };
}

function displayName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\x00-\x1f\x7f]/g, ' ').trim()).slice(0, 128).join('');
}

function canonicalPerson(person) {
  while (person.parent) person = person.parent;
  return person;
}

/** A command-scoped copy only. No disk writes, contact fetches, or conversation archive. */
export function normalizeMessages(rawMessages, groupId, { ownIds = [], participants = [] } = {}) {
  if (!Array.isArray(rawMessages)) throw new TypeError('Messages must be an array.');
  const own = ownSet(ownIds);
  const people = new Map();
  for (const participant of Array.isArray(participants) ? participants : []) {
    const aliases = [participant?.id, participant?.lid, participant?.phoneNumber].map(normalizeJid).filter(Boolean);
    const person = { name: displayName(participant?.name) || displayName(participant?.notify), rawName: false };
    for (const id of aliases) people.set(id, person);
  }
  const rows = [];
  let anonymous = 0;
  for (const raw of rawMessages) {
    if (raw?.key?.remoteJid !== groupId || !validId(raw?.key?.id)) continue;
    const timestamp = messageTimestamp(raw);
    if (!Number.isFinite(timestamp)) continue;
    const content = extractContent(raw);
    const bot = fromBot(raw, own);
    const ids = senderIds(raw);
    const known = ids.map(id => people.get(id)).filter(Boolean).map(canonicalPerson);
    let person = known[0];
    if (!person) person = { name: '', rawName: false };
    for (const alias of known) {
      if (alias === person) continue;
      if (!person.rawName && alias.rawName) { person.name = alias.name; person.rawName = true; }
      alias.parent = person;
    }
    for (const id of ids) people.set(id, person);
    if (!person.rawName) {
      const rawName = displayName(raw.pushName) || displayName(raw.verifiedBizName);
      if (rawName) { person.name = rawName; person.rawName = true; }
    }
    if (!person.name) person.name = `Participant ${++anonymous}`;
    rows.push({
      id: raw.key.id, groupId, text: content.text, type: content.type,
      timestamp, fromBot: bot, isCommand: isSummariseCommand(content.text) || getGreetingKind(content.text) !== null,
      deleted: content.deleted, person,
    });
  }
  return rows.map(({ person, ...row }) => ({ ...row, sender: row.fromBot ? 'Bot' : canonicalPerson(person).name }));
}
