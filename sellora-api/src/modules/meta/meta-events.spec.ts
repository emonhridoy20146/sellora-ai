import { describe, expect, it } from 'vitest';
import { parseMetaWebhook } from './meta-events.js';

// Shapes follow Meta's webhook reference for Messenger, Instagram and the WhatsApp Cloud API.
const PAGE = '1029384756';
const PSID = '5550001112223';

const page = (messaging: unknown[]) => ({
  object: 'page',
  entry: [{ id: PAGE, time: 1_761_600_000_000, messaging }],
});

describe('parseMetaWebhook', () => {
  it('reads a Messenger text message', () => {
    const events = parseMetaWebhook(
      page([
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          timestamp: 1_761_600_000_123,
          message: { mid: 'm_abc', text: 'Saree ache?' },
        },
      ]),
    );
    expect(events).toEqual([
      {
        kind: 'message',
        channelType: 'messenger',
        accountId: PAGE,
        senderId: PSID,
        messageId: 'm_abc',
        at: new Date(1_761_600_000_123),
        type: 'text',
        text: 'Saree ache?',
        attachments: [],
      },
    ]);
  });

  it('reads photos and files, and a tapped button as text', () => {
    const [photo, file, tap] = parseMetaWebhook(
      page([
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          timestamp: 1,
          message: {
            mid: 'm_photo',
            attachments: [{ type: 'image', payload: { url: 'https://cdn.example/p.jpg' } }],
          },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          timestamp: 2,
          message: {
            mid: 'm_file',
            text: 'invoice',
            attachments: [{ type: 'file', payload: { url: 'https://cdn.example/a.pdf' } }],
          },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          timestamp: 3,
          postback: { mid: 'm_tap', title: 'Order now', payload: 'ORDER' },
        },
      ]),
    );
    expect(photo).toMatchObject({
      type: 'image',
      text: '',
      attachments: [{ kind: 'image', url: 'https://cdn.example/p.jpg' }],
    });
    expect(file).toMatchObject({
      type: 'file',
      text: 'invoice',
      attachments: [{ kind: 'file', url: 'https://cdn.example/a.pdf', name: 'file' }],
    });
    expect(tap).toMatchObject({ kind: 'message', messageId: 'm_tap', text: 'Order now' });
  });

  it('reads echoes of messages the page sent, with the sending app', () => {
    const [echo] = parseMetaWebhook(
      page([
        {
          sender: { id: PAGE },
          recipient: { id: PSID },
          timestamp: 5,
          message: { mid: 'm_echo', is_echo: true, app_id: 263902037430900, text: 'Ji ache' },
        },
      ]),
    );
    expect(echo).toEqual({
      kind: 'echo',
      channelType: 'messenger',
      accountId: PAGE,
      recipientId: PSID,
      messageId: 'm_echo',
      at: new Date(5),
      text: 'Ji ache',
      appId: '263902037430900',
    });
  });

  it('reads delivery and read reports by message id or by time', () => {
    const events = parseMetaWebhook(
      page([
        {
          sender: { id: PSID },
          recipient: { id: PAGE },
          delivery: { mids: ['m_1', 'm_2'], watermark: 1_761_600_000_000 },
        },
        { sender: { id: PSID }, recipient: { id: PAGE }, read: { watermark: 1_761_600_100_000 } },
      ]),
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: 'status', messageId: 'm_1', status: 'delivered' }),
      expect.objectContaining({ kind: 'status', messageId: 'm_2', status: 'delivered' }),
      expect.objectContaining({
        kind: 'status',
        status: 'read',
        contactId: PSID,
        watermark: new Date(1_761_600_100_000),
      }),
    ]);
  });

  it('skips deleted, unsupported and empty messages and unknown shapes', () => {
    expect(
      parseMetaWebhook(
        page([
          {
            sender: { id: PSID },
            recipient: { id: PAGE },
            message: { mid: 'x', is_deleted: true },
          },
          {
            sender: { id: PSID },
            recipient: { id: PAGE },
            message: { mid: 'y', is_unsupported: true },
          },
          { sender: { id: PSID }, recipient: { id: PAGE }, message: { mid: 'z' } },
          { sender: { id: PSID }, recipient: { id: PAGE }, reaction: { action: 'react' } },
          { message: { mid: 'no-sender', text: 'hi' } },
        ]),
      ),
    ).toEqual([]);
    expect(parseMetaWebhook({ object: 'user', entry: [{}] })).toEqual([]);
    expect(parseMetaWebhook(null)).toEqual([]);
    expect(parseMetaWebhook('nope')).toEqual([]);
  });

  it('reads Instagram messages against the Instagram account', () => {
    const [m] = parseMetaWebhook({
      object: 'instagram',
      entry: [
        {
          id: '17841400000000001',
          messaging: [
            {
              sender: { id: '7770001' },
              recipient: { id: '17841400000000001' },
              timestamp: 9,
              message: { mid: 'ig_1', text: 'price?' },
            },
          ],
        },
      ],
    });
    expect(m).toMatchObject({
      kind: 'message',
      channelType: 'instagram',
      accountId: '17841400000000001',
      senderId: '7770001',
    });
  });

  describe('WhatsApp', () => {
    const wa = (value: Record<string, unknown>) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '8801700000000', phone_number_id: '1122334455' },
                ...value,
              },
            },
          ],
        },
      ],
    });

    it('reads text with the profile name, seconds timestamps and the number', () => {
      const [m] = parseMetaWebhook(
        wa({
          contacts: [{ profile: { name: 'Karim' }, wa_id: '8801711111111' }],
          messages: [
            {
              from: '8801711111111',
              id: 'wamid.A',
              timestamp: '1761600000',
              type: 'text',
              text: { body: 'Panjabi koto?' },
            },
          ],
        }),
      );
      expect(m).toEqual({
        kind: 'message',
        channelType: 'whatsapp',
        accountId: '1122334455',
        senderId: '8801711111111',
        messageId: 'wamid.A',
        at: new Date(1_761_600_000_000),
        type: 'text',
        text: 'Panjabi koto?',
        attachments: [],
        profileName: 'Karim',
      });
    });

    it('reads buttons, list replies, photos, documents and locations', () => {
      const base = { from: '8801711111111', timestamp: '1' };
      const events = parseMetaWebhook(
        wa({
          messages: [
            { ...base, id: 'w1', type: 'button', button: { text: 'Yes', payload: 'Y' } },
            {
              ...base,
              id: 'w2',
              type: 'interactive',
              interactive: { type: 'list_reply', list_reply: { id: 'r', title: 'Size M' } },
            },
            {
              ...base,
              id: 'w3',
              type: 'image',
              image: { id: 'MEDIA', caption: 'this one', mime_type: 'image/jpeg' },
            },
            { ...base, id: 'w4', type: 'document', document: { id: 'M2', filename: 'memo.pdf' } },
            {
              ...base,
              id: 'w5',
              type: 'location',
              location: { latitude: 23.81, longitude: 90.41, name: 'Gulshan' },
            },
            { ...base, id: 'w6', type: 'reaction', reaction: { emoji: '👍' } },
          ],
        }),
      );
      expect(events.map((e) => (e.kind === 'message' ? [e.type, e.text] : null))).toEqual([
        ['text', 'Yes'],
        ['text', 'Size M'],
        ['image', 'this one'],
        ['file', 'memo.pdf'],
        ['text', 'Shared a location: Gulshan: https://maps.google.com/?q=23.81,90.41'],
      ]);
      expect(events[2]).toMatchObject({
        attachments: [{ kind: 'image', mediaId: 'MEDIA', contentType: 'image/jpeg' }],
      });
    });

    it('reads statuses, with the reason for a failure', () => {
      const events = parseMetaWebhook(
        wa({
          statuses: [
            { id: 'wamid.S1', status: 'delivered', timestamp: '2', recipient_id: '88017' },
            {
              id: 'wamid.S2',
              status: 'failed',
              timestamp: '3',
              recipient_id: '88017',
              errors: [{ code: 131047, title: 'Re-engagement message' }],
            },
            { id: 'wamid.S3', status: 'deleted' },
          ],
        }),
      );
      expect(events).toEqual([
        {
          kind: 'status',
          channelType: 'whatsapp',
          accountId: '1122334455',
          messageId: 'wamid.S1',
          status: 'delivered',
        },
        {
          kind: 'status',
          channelType: 'whatsapp',
          accountId: '1122334455',
          messageId: 'wamid.S2',
          status: 'failed',
          error: 'Re-engagement message',
        },
      ]);
    });

    it('ignores other fields and values without a phone number id', () => {
      expect(
        parseMetaWebhook({
          object: 'whatsapp_business_account',
          entry: [
            { changes: [{ field: 'account_update', value: { event: 'VERIFIED_ACCOUNT' } }] },
            { changes: [{ field: 'messages', value: { messages: [{ id: 'x', from: '1' }] } }] },
          ],
        }),
      ).toEqual([]);
    });
  });
});
