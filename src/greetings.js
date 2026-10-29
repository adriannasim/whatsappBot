import { randomInt } from 'node:crypto';

const phrases = {
  gm: [
    'A small step today can become something you are proud of tomorrow. You have got this!',
    'You do not need a perfect start. Begin with one good thing and build from there.',
    'Take the day one step at a time. Your effort matters, even when progress feels small.',
    'Make room for something that brings you joy today. You deserve a good day too.',
    'Today is a fresh chance to learn, grow, and be kind to yourself along the way.',
    'Start gently, stay curious, and give yourself credit for showing up.',
    'Choose one thing that matters to you and take a little step towards it today.',
    'You bring something valuable to this day. Go at your own pace and keep going.',
  ],
  gn: [
    'You have done enough for today. Rest well and give tomorrow a fresh start.',
    'Give yourself credit for making it through today. You can set the unfinished things down for tonight.',
    'Some days are for progress, and some are for getting through. Either way, you deserve rest.',
    'Let your mind slow down and your shoulders relax. Tomorrow can wait until morning.',
    'Rest is part of moving forward. Be kind to yourself and recharge for a new day.',
    'Remember one small thing you did well today, then let yourself rest. Good job showing up.',
    'You do not have to solve everything tonight. Take a breath and rest at your own pace.',
    'Whatever today brought, you can begin again tomorrow. Wishing you a peaceful night.',
  ],
};

/** Recognize complete greeting command tokens; conflicting commands are ignored. */
export function getGreetingKind(text) {
  if (typeof text !== 'string') return null;
  const morning = /(?:^|\s)!gm(?=\s|$)/i.test(text);
  const night = /(?:^|\s)!gn(?=\s|$)/i.test(text);
  return morning === night ? null : morning ? 'gm' : 'gn';
}

/** senderJid must come from the message's verified participant metadata. */
export function createGreeting(kind, senderJid) {
  if (kind !== 'gm' && kind !== 'gn') throw new TypeError('Unknown greeting command.');
  const sender = typeof senderJid === 'string' && /^(\d+)@(s\.whatsapp\.net|lid)$/.exec(senderJid);
  if (!sender || sender[0] !== senderJid || senderJid.length > 256) {
    throw new TypeError('Greeting recipient must be a normalized participant JID.');
  }
  const greeting = kind === 'gm' ? 'Good morning' : 'Good night';
  const phrase = phrases[kind][randomInt(phrases[kind].length)];
  return { text: `${greeting} @${sender[1]}!\n\n${phrase}`, mentions: [senderJid] };
}
