import { currencyInfo, fromMinor } from '../../../common/money/money.js';

const BENGALI = /[ঀ-৿]/;

/** True when the text is written in Bengali script. */
export function hasBengaliScript(text: string): boolean {
  return BENGALI.test(text);
}

/** "৳1,250" or "৳1,250.50": the way prices read in a chat. */
export function chatMoney(minor: number, currency: string): string {
  const { symbol, minorUnits } = currencyInfo(currency);
  const [whole = '0', frac = ''] = fromMinor(Math.abs(minor), currency).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const tail = minorUnits > 0 && /[1-9]/.test(frac) ? `.${frac}` : '';
  return `${minor < 0 ? '-' : ''}${symbol}${grouped}${tail}`;
}

/** Messenger rejects longer messages; the widget shows them, but a chat reply should never be this long. */
export const MAX_CHAT_REPLY = 2_000;

/**
 * Turns a model reply into plain chat text. Chat apps show Markdown literally, so emphasis
 * and headings are unwrapped; lists and line breaks stay.
 */
export function toChatText(text: string): string {
  let out = text
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,!?]|$)/g, '$1$2')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > MAX_CHAT_REPLY) {
    const cut = out.slice(0, MAX_CHAT_REPLY - 1);
    const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf('। '));
    out = `${lastBreak > MAX_CHAT_REPLY / 2 ? cut.slice(0, lastBreak + 1) : cut}…`.trim();
  }
  return out;
}

/** Folds case and spacing so keywords match however they are typed. */
function fold(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
}

/** The first handover keyword found in `text`, matched on word boundaries. */
export function matchKeyword(text: string, keywords: readonly string[]): string | null {
  const haystack = ` ${fold(text)} `;
  for (const raw of keywords) {
    const k = fold(raw);
    if (!k) continue;
    // Bengali has no case and \b does not work on it; pad with spaces and punctuation instead.
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[\\s.,!?।"'()])${escaped}(?=$|[\\s.,!?।"'()])`, 'u');
    if (re.test(haystack)) return raw;
  }
  return null;
}

/** What the customer is told when the chat moves to a person and the AI did not write it. */
export function handoverNotice(custom: string, customerText: string): string {
  if (custom.trim()) return custom.trim();
  return hasBengaliScript(customerText)
    ? 'ধন্যবাদ! আমাদের টিমের একজন শীঘ্রই আপনাকে উত্তর দেবেন।'
    : 'Thanks for your message! A member of our team will reply to you shortly.';
}

/**
 * A generous token estimate for reserving credits before a call (the real count is charged
 * afterwards). Bengali script takes far more tokens per character than English, so it is
 * counted at one token per character.
 */
export function estimateTokens(text: string): number {
  let bengali = 0;
  for (const ch of text) if (BENGALI.test(ch)) bengali++;
  const other = text.length - bengali;
  return Math.ceil(bengali + other / 3);
}
