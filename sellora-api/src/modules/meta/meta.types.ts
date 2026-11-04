import type { ChannelType } from '../inbox/schemas.js';

export type MetaChannelType = Exclude<ChannelType, 'web_chat'>;

export const META_CHANNEL_TYPES: readonly MetaChannelType[] = [
  'messenger',
  'instagram',
  'whatsapp',
];

export function isMetaChannel(type: ChannelType): type is MetaChannelType {
  return type !== 'web_chat';
}

/** Longest text one message may carry on each channel. Longer replies are split. */
export const MAX_TEXT: Record<MetaChannelType, number> = {
  messenger: 2_000,
  instagram: 1_000,
  whatsapp: 4_096,
};

export const CHANNEL_NAME: Record<MetaChannelType, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram',
  whatsapp: 'WhatsApp',
};

/**
 * Splits text into parts of at most `max` characters (code points, so an emoji or a Bangla
 * conjunct's surrogate pair is never cut), preferring paragraph, line, sentence and word
 * breaks in that order.
 */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest) {
    const chars = Array.from(rest);
    if (chars.length <= max) {
      parts.push(rest);
      break;
    }
    const head = chars.slice(0, max).join('');
    const min = Math.floor(head.length / 2);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '. ', '। ', '? ', '! ', ' ']) {
      const at = head.lastIndexOf(sep);
      if (at >= min) {
        cut = at + sep.length;
        break;
      }
    }
    const piece = cut > 0 ? head.slice(0, cut) : head;
    parts.push(piece.trim());
    rest = rest.slice(piece.length).trim();
  }
  return parts.filter(Boolean);
}
