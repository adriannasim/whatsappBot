import { HistoryUnavailableError } from './history-error.js';

const MAX_REPLY_LENGTH = 3500;
const COMMAND_TTL_MS = 60 * 60 * 1000;
const MAX_REMEMBERED_COMMANDS = 1000;

export function isSummariseCommand(text) {
  return typeof text === 'string' && /(?:^|\s)!summarise(?=\s|$)/i.test(text);
}

function splitReply(text) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_REPLY_LENGTH) {
    let end = MAX_REPLY_LENGTH;
    // Do not split a UTF-16 surrogate pair (for example, an emoji).
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1;
    const newline = remaining.lastIndexOf('\n', end - 1);
    const space = remaining.lastIndexOf(' ', end - 1);
    if (newline > end / 2) end = newline + 1;
    else if (space > end / 2) end = space + 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

const malaysiaDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
});

function localTime(timestamp) {
  const parts = Object.fromEntries(malaysiaDateTime.formatToParts(new Date(timestamp * 1000))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date: `${parts.day} ${parts.month} ${parts.year}`, clock: `${parts.hour}:${parts.minute}`, period: parts.dayPeriod.toLowerCase() };
}

function rangeLabel(startTimestamp, endTimestamp) {
  const start = localTime(startTimestamp);
  const end = localTime(endTimestamp);
  const endTime = `${end.clock} ${end.period}`;
  if (start.date !== end.date) {
    return `${start.date}, ${start.clock} ${start.period}\n→ ${end.date}, ${endTime} MYT`;
  }
  const startTime = `${start.clock}${start.period === end.period ? '' : ` ${start.period}`}`;
  const range = start.clock === end.clock && start.period === end.period ? endTime : `${startTime}–${endTime}`;
  return `${start.date} · ${range} MYT`;
}

/**
 * Load a buffered range or phone history when a mentioned command has a quoted start.
 * loadMessages must return the requested range, inclusive of the anchor and
 * exclusive of the command. No conversation history is persisted here.
 */
export function createSummaryService({
  loadMessages,
  summarize,
  reply,
  onPause = () => {},
  onError = () => {},
  now = () => Date.now(),
  cooldownMs = 30_000,
}) {
  const activeGroups = new Set();
  const lastSuccess = new Map();
  const seenCommands = new Map();
  let planPaused = false;

  return async function handle({ command, mentioned, quotedId }) {
    if (!command || command.fromBot || !mentioned || !isSummariseCommand(command.text)) {
      return 'ignored';
    }

    const { groupId, id } = command;
    const currentTime = now();
    for (const [key, seenAt] of seenCommands) {
      if (currentTime - seenAt >= COMMAND_TTL_MS) seenCommands.delete(key);
    }
    const commandKey = JSON.stringify([groupId, id]);
    if (seenCommands.has(commandKey)) return 'duplicate';
    if (seenCommands.size >= MAX_REMEMBERED_COMMANDS) {
      seenCommands.delete(seenCommands.keys().next().value);
    }
    // Remember IDs only, in memory. A failed command can be retried by sending
    // a new command message, without retaining any conversation content.
    seenCommands.set(commandKey, currentTime);
    if (planPaused) {
      await reply(groupId, id, 'Summaries are paused because the bot reached its ChatGPT usage limit. The bot owner needs to restore access before summaries can continue.');
      return 'plan-paused';
    }
    if (activeGroups.has(groupId)) {
      await reply(groupId, id, 'A summary is already being prepared for this group. Please wait for it to finish.');
      return 'busy';
    }
    const elapsed = now() - (lastSuccess.get(groupId) ?? -Infinity);
    if (elapsed < cooldownMs) {
      const seconds = Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000));
      await reply(groupId, id, `Please wait ${seconds} seconds before requesting another summary.`);
      return 'cooldown';
    }

    activeGroups.add(groupId);
    try {
      if (!quotedId) {
        await reply(groupId, id, 'Reply to the first message you want included, then mention the bot and send !summarise.');
        return 'missing-quote';
      }

      const loaded = await loadMessages({ groupId, startId: quotedId, endId: id });
      const rows = Array.isArray(loaded) ? loaded : loaded?.messages;
      const coverageIncomplete = !Array.isArray(loaded) && loaded?.coverageIncomplete === true;
      if (!Array.isArray(rows)) throw new Error('Invalid history result');
      const snapshot = rows
        .filter(row => row.groupId === groupId && row.id !== id)
        .map(row => ({ ...row }));
      const anchor = snapshot.find(row => row.id === quotedId);
      if (!anchor) {
        await reply(groupId, id, 'I could not retrieve that starting message from WhatsApp. Reply to a newer starting message and try !summarise again.');
        return 'missing-history';
      }

      // The copied snapshot cannot change while the AI request is in progress.
      const eligible = snapshot.filter(row => !row.deleted && !row.fromBot && !row.isCommand);
      const messages = eligible
        .filter(row => typeof row.text === 'string' && row.text.trim())
        .map(row => ({ ...row, text: row.text.trim() }));
      if (messages.length === 0) {
        await reply(groupId, id, 'There are no available text messages or captions to summarise in that range. Voice notes, images without captions, deleted messages and bot replies are not included.');
        return 'empty';
      }

      const omitted = eligible.length - messages.length;
      const header = [
        '*Chat summary*',
        rangeLabel(anchor.timestamp, command.timestamp),
        `${messages.length} message${messages.length === 1 ? '' : 's'} summarised`,
        ...(coverageIncomplete ? ['_Some messages from an offline or recovery gap may be missing._'] : []),
      ].join('\n');
      const footer = omitted ? `\n\n_${omitted} non-text message${omitted === 1 ? '' : 's'} skipped._` : '';

      // Another group may have exhausted the shared allowance during this fetch.
      if (planPaused) {
        await reply(groupId, id, 'Summaries are paused because the bot reached its ChatGPT usage limit. The bot owner needs to restore access before summaries can continue.');
        return 'plan-paused';
      }
      const summary = await summarize(messages);
      if (typeof summary !== 'string' || !summary.trim()) throw new Error('Empty summary');
      for (const chunk of splitReply(`${header}\n\n${summary.trim()}${footer}`)) {
        await reply(groupId, id, chunk);
      }
      lastSuccess.set(groupId, now());
      return 'summarised';
    } catch (error) {
      if (error?.code === 'HISTORY_UNAVAILABLE') {
        // Only our fixed recovery guidance is safe to log or send to the group.
        const detail = error instanceof HistoryUnavailableError
          ? error.message : 'WhatsApp history is unavailable.';
        try { onError(`History retrieval failed: ${detail}`); }
        catch { /* Diagnostics must not prevent the recovery reply. */ }
      }
      if (error?.code === 'PLAN_LIMIT') {
        planPaused = true;
        try { onPause(); } catch { /* Logging must not prevent the user-facing reply. */ }
      }
      const planMessages = {
        PLAN_LIMIT: 'The bot has reached its ChatGPT usage limit. The owner can check ChatGPT Settings > Usage before trying again.',
        PLAN_UNAVAILABLE: 'ChatGPT plan usage is temporarily unavailable. Please try again later; the owner can check ChatGPT Settings > Usage.',
        AUTH_REQUIRED: 'The bot owner needs to reconnect ChatGPT before summaries can continue.',
        AUTH_UNAVAILABLE: 'ChatGPT authentication is temporarily unavailable. Please try again shortly.',
        AUTH_DENIED: 'The bot owner needs to reconnect ChatGPT and authorise plan usage before summaries can continue.',
        SUBSCRIPTION_NOT_ENABLED: 'The bot owner needs to authorise ChatGPT plan usage before summaries can continue.',
        MODEL_UNAVAILABLE: 'The configured summary model is unavailable. The bot owner needs to choose another available model.',
      };
      const message = error instanceof HistoryUnavailableError ? error.message
        : planMessages[error?.code] || (error?.code === 'HISTORY_UNAVAILABLE'
        ? 'I could not retrieve that starting message or the requested range from WhatsApp. Keep the bot phone online, then reply to a newer starting message and try !summarise again.'
        : error?.code === 'INPUT_TOO_LARGE'
          ? 'That conversation is too long for one summary. Reply to a newer starting message and send !summarise again.'
          : 'I could not complete the summary. Please try again with a new !summarise command in a moment.');
      // Do not include API errors, tokens or internal message IDs in chat.
      await reply(groupId, id, message);
      return 'failed';
    } finally {
      activeGroups.delete(groupId);
    }
  };
}
