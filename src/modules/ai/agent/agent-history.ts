import type { MessageDoc } from '../../inbox/inbox.mappers.js';
import type { AiMessage } from '../provider/ai-provider.js';

/** About 4K tokens of English: enough context for a sales chat, cheap to resend each turn. */
export const HISTORY_CHARS = 16_000;

/** The agent's view of the conversation: customer turns and the business's replies. */
export function toAgentHistory(
  history: Pick<MessageDoc, 'direction' | 'type' | 'text' | 'attachments'>[],
): AiMessage[] {
  const turns: AiMessage[] = [];
  for (const m of history) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    let text = m.text.trim();
    if (m.type !== 'text' || m.attachments.length) {
      const what = m.type === 'image' ? 'a photo' : 'a file';
      text = `[${m.direction === 'in' ? 'The customer sent' : 'We sent'} ${what}]${text ? ` ${text}` : ''}`;
    }
    if (!text) continue;
    const last = turns.at(-1);
    if (last && last.role === role && (last.role === 'user' || last.role === 'assistant'))
      last.text = `${last.text}\n${text}`;
    else turns.push(role === 'user' ? { role: 'user', text } : { role: 'assistant', text });
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
