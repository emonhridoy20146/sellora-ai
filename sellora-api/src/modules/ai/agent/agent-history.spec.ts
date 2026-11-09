import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { AiImage } from '../provider/ai-provider.js';
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

  it('numbers the photos the model sees and keeps the two sides alternating', () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    const img = (data: string): AiImage => ({
      mediaType: 'image/jpeg',
      data,
      width: 800,
      height: 600,
    });
    const photo = { url: '', status: 'ready' } as Msg['attachments'][number];
    const turns = toAgentHistory(
      [
        msg('in', 'old', { type: 'image', attachments: [photo] }),
        msg('out', 'Ji bolun'),
        msg('in', 'eta ache?', { _id: a, type: 'image', attachments: [photo, photo] }),
        msg('in', 'ar eta?', { _id: b, type: 'image', attachments: [photo] }),
        msg('in', 'lost', {
          type: 'image',
          attachments: [{ url: '', status: 'failed' }],
        }),
      ],
      new Map([
        [a.toHexString(), [img('A1'), img('A2')]],
        [b.toHexString(), [img('B1')]],
      ]),
    );
    expect(turns).toEqual([
      { role: 'user', text: '[The customer sent a photo] old' },
      { role: 'assistant', text: 'Ji bolun' },
      {
        role: 'user',
        text:
          '[The customer sent Photo 1, Photo 2] eta ache?\n' +
          '[The customer sent Photo 3] ar eta?\n' +
          '[The customer sent a photo that could not be loaded] lost',
        images: [
          { ...img('A1'), label: 'Photo 1' },
          { ...img('A2'), label: 'Photo 2' },
          { ...img('B1'), label: 'Photo 3' },
        ],
      },
    ]);
  });

  describe('voice notes', () => {
    const voice = (transcript?: Msg['attachments'][number]['transcript'], durationMs?: number) =>
      ({
        kind: 'audio',
        url: '',
        status: 'ready',
        ...(durationMs ? { durationMs } : {}),
        ...(transcript ? { transcript } : {}),
      }) as Msg['attachments'][number];

    it('gives the agent the words speech-to-text heard, with the length', () => {
      expect(
        toAgentHistory([
          msg('in', '', {
            type: 'audio',
            attachments: [voice({ status: 'done', text: 'lal saree ta ache?', tries: 1 }, 4_200)],
          }),
        ]),
      ).toEqual([
        {
          role: 'user',
          text: '[The customer sent a voice note (0:04). Speech-to-text heard: "lal saree ta ache?"]',
        },
      ]);
    });

    it('says when there were no words, when they are still coming, and when they failed', () => {
      const [turn] = toAgentHistory([
        msg('in', '', {
          type: 'audio',
          attachments: [voice({ status: 'done', text: '', tries: 1 })],
        }),
        msg('in', '', {
          type: 'audio',
          attachments: [voice({ status: 'pending', tries: 0 }, 61_000)],
        }),
        msg('in', '', {
          type: 'audio',
          attachments: [voice({ status: 'failed', error: 'x', tries: 3 })],
        }),
        msg('in', '', {
          type: 'audio',
          attachments: [voice({ status: 'skipped', error: 'off', tries: 0 })],
        }),
        msg('in', '', { type: 'audio', attachments: [voice()] }),
      ]);
      expect(turn).toEqual({
        role: 'user',
        text: [
          '[The customer sent a voice note with no clear words in it]',
          '[The customer sent a voice note (1:01) that is still being turned into text]',
          '[The customer sent a voice note that could not be turned into text]',
          '[The customer sent a voice note that could not be turned into text]',
          '[The customer sent a voice note that could not be turned into text]',
        ].join('\n'),
      });
    });

    it('keeps photo labels when a voice note and a photo come together', () => {
      const id = new Types.ObjectId();
      const photo: AiImage = { mediaType: 'image/jpeg', data: 'AAAA', width: 10, height: 10 };
      const [turn] = toAgentHistory(
        [
          msg('in', 'eta', {
            _id: id,
            type: 'audio',
            attachments: [
              voice({ status: 'done', text: 'ei design ta', tries: 1 }),
              { kind: 'image', url: '', status: 'ready' },
            ],
          }),
        ],
        new Map([[id.toHexString(), [photo]]]),
      );
      expect(turn).toMatchObject({
        role: 'user',
        text: '[The customer sent a voice note. Speech-to-text heard: "ei design ta"] [The customer sent Photo 1] eta',
      });
    });
  });
});
