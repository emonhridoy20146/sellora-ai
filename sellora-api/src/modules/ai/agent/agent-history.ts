import type { MessageDoc } from '../../inbox/inbox.mappers.js';
import type { AiImage, AiMessage } from '../provider/ai-provider.js';

/** About 4K tokens of English: enough context for a sales chat, cheap to resend each turn. */
export const HISTORY_CHARS = 16_000;

type HistoryMessage = Pick<MessageDoc, 'direction' | 'type' | 'text' | 'attachments'> & {
  _id?: MessageDoc['_id'];
};

function describe(m: HistoryMessage, shown: AiImage[]): string {
  const text = m.text.trim();
  if (m.type === 'text' && !m.attachments.length) return text;
  let label: string;
  if (shown.length === 1) label = `[The customer sent ${shown[0]!.label}]`;
  else if (shown.length > 1) label = `[The customer sent ${shown.map((p) => p.label).join(', ')}]`;
  else {
    const what = m.type === 'image' ? 'a photo' : 'a file';
    const lost =
      m.direction === 'in' &&
      m.type === 'image' &&
      m.attachments.some((a) => a.status === 'failed');
    label = `[${m.direction === 'in' ? 'The customer sent' : 'We sent'} ${what}${lost ? ' that could not be loaded' : ''}]`;
  }
  return `${label}${text ? ` ${text}` : ''}`;
}

/**
 * The agent's view of the conversation: customer turns and the business's replies, merged
 * so the two sides alternate. `images` holds the photos the model may see, by message id;
 * each is numbered ("Photo 1") and the text says which message it came with.
 */
export function toAgentHistory(
  history: HistoryMessage[],
  images: ReadonlyMap<string, AiImage[]> = new Map(),
): AiMessage[] {
  const turns: AiMessage[] = [];
  let photoNo = 0;
  for (const m of history) {
    const pics = ((m._id && images.get(m._id.toHexString())) || []).map((img) => ({
      ...img,
      label: `Photo ${(photoNo += 1)}`,
    }));
    const text = describe(m, pics);
    if (!text) continue;
    const last = turns.at(-1);
    if (m.direction === 'in') {
      if (last?.role === 'user') {
        last.text = `${last.text}\n${text}`;
        if (pics.length) last.images = [...(last.images ?? []), ...pics];
      } else turns.push({ role: 'user', text, ...(pics.length ? { images: pics } : {}) });
    } else if (last?.role === 'assistant') last.text = `${last.text}\n${text}`;
    else turns.push({ role: 'assistant', text });
  }
  // The conversation must start with the customer; keep the newest turns within budget.
  while (turns.length && turns[0]!.role !== 'user') turns.shift();
  let size = turns.reduce((a, t) => a + ('text' in t ? t.text.length : 0), 0);
  while (turns.length > 1 && size > HISTORY_CHARS) {
    const dropped = turns.shift()!;
    size -= 'text' in dropped ? dropped.text.length : 0;
    while (turns.length && turns[0]!.role !== 'user') {
      const next = turns.shift()!;
      size -= 'text' in next ? next.text.length : 0;
    }
  }
  return turns;
}
