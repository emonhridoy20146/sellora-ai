import { describe, expect, it } from 'vitest';
import { HISTORY_CHARS, toAgentHistory } from './agent-history.js';

type Msg = Parameters<typeof toAgentHistory>[0][number];
const msg = (direction: 'in' | 'out', text: string, extra: Partial<Msg> = {}): Msg => ({
  direction,
  type: 'text',
  text,
  attachments: [],
  ...extra,
});

describe('agent history', () => {
  it('merges consecutive messages from the same side into one turn', () => {
    expect(
      toAgentHistory([
        msg('in', 'ami ekta panjabi chai'),
        msg('in', 'L size ache?'),
        msg('out', 'Ji ache!'),
        msg('out', 'Dam ৳1,500.'),
        msg('in', 'nibo'),
      ]),
    ).toEqual([
      { role: 'user', text: 'ami ekta panjabi chai\nL size ache?' },
      { role: 'assistant', text: 'Ji ache!\nDam ৳1,500.' },
      { role: 'user', text: 'nibo' },
    ]);
  });

  it('describes photos and files, and skips empty messages', () => {
    expect(
      toAgentHistory([
        msg('in', '', { type: 'image', attachments: [{} as Msg['attachments'][number]] }),
        msg('in', 'eta ache?', { type: 'image', attachments: [{} as Msg['attachments'][number]] }),
        msg('in', '   '),
        msg('out', 'size chart', { type: 'file', attachments: [{} as Msg['attachments'][number]] }),
      ]),
    ).toEqual([
      { role: 'user', text: '[The customer sent a photo]\n[The customer sent a photo] eta ache?' },
      { role: 'assistant', text: '[We sent a file] size chart' },
    ]);
  });

  it('always starts with the customer', () => {
    expect(toAgentHistory([msg('out', 'Welcome!'), msg('in', 'hi')])).toEqual([
      { role: 'user', text: 'hi' },
    ]);
    expect(toAgentHistory([msg('out', 'Welcome!')])).toEqual([]);
  });

  it('keeps the newest turns within the budget, still starting with the customer', () => {
    const long = 'x'.repeat(HISTORY_CHARS / 2);
    const turns = toAgentHistory([
      msg('in', long),
      msg('out', long),
      msg('in', 'kono discount ache?'),
      msg('out', 'Na, dukkhito.'),
      msg('in', 'thik ache, nibo'),
    ]);
    expect(turns[0]).toEqual({ role: 'user', text: 'kono discount ache?' });
    expect(turns).toHaveLength(3);
    // A single huge message is still sent rather than nothing.
    expect(toAgentHistory([msg('in', 'y'.repeat(HISTORY_CHARS * 2))])).toHaveLength(1);
  });
});
