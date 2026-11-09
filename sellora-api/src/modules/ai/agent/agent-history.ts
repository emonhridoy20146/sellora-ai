import { formatClock } from '../../../common/media/audio-length.js';
import type { MessageDoc } from '../../inbox/inbox.mappers.js';
import { attachmentKind, type MessageAttachment } from '../../inbox/schemas.js';
import type { AiImage, AiMessage } from '../provider/ai-provider.js';

/** About 4K tokens of English: enough context for a sales chat, cheap to resend each turn. */
export const HISTORY_CHARS = 16_000;

type HistoryMessage = Pick<MessageDoc, 'direction' | 'type' | 'text' | 'attachments'> & {
  _id?: MessageDoc['_id'];
};

/**
 * A customer's voice note as the agent reads it (ADR 0025): its length and the words
 * speech-to-text heard, or why there are none.
 */
export function voiceNoteLine(
  a: Pick<MessageAttachment, 'durationMs' | 'transcript' | 'status'>,
): string {
  const length = a.durationMs ? ` (${formatClock(a.durationMs)})` : '';
  const t = a.transcript;
  if (t?.status === 'done') {
    const words = (t.text ?? '').trim();
    return words
      ? `[The customer sent a voice note${length}. Speech-to-text heard: "${words}"]`
      : `[The customer sent a voice note${length} with no clear words in it]`;
  }
  if (t?.status === 'pending')
    return `[The customer sent a voice note${length} that is still being turned into text]`;
  return `[The customer sent a voice note${length} that could not be turned into text]`;
}

function otherLabel(m: HistoryMessage, shown: AiImage[]): string {
  if (shown.length === 1) return `[The customer sent ${shown[0]!.label}]`;
  if (shown.length > 1) return `[The customer sent ${shown.map((p) => p.label).join(', ')}]`;
  const what = m.type === 'image' ? 'a photo' : 'a file';
  const lost =
    m.direction === 'in' && m.type === 'image' && m.attachments.some((a) => a.status === 'failed');
  return `[${m.direction === 'in' ? 'The customer sent' : 'We sent'} ${what}${lost ? ' that could not be loaded' : ''}]`;
}

function describe(m: HistoryMessage, shown: AiImage[]): string {
  const text = m.text.trim();
  if (m.type === 'text' && !m.attachments.length) return text;
  const labels: string[] = [];
  if (m.direction === 'in')
    for (const a of m.attachments) if (attachmentKind(a) === 'audio') labels.push(voiceNoteLine(a));
  if (!labels.length || m.attachments.some((a) => attachmentKind(a) !== 'audio'))
    labels.push(otherLabel(m, shown));
  return `${labels.join(' ')}${text ? ` ${text}` : ''}`;
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
