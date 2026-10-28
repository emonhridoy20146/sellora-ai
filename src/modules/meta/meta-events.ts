import type { MetaChannelType } from './meta.types.js';

/** One thing that happened on a Meta channel, in a shape the inbox understands. */
export type MetaEvent =
  | {
      kind: 'message';
      channelType: MetaChannelType;
      /** Page id, Instagram account id or WhatsApp phone number id. */
      accountId: string;
      /** The customer's id on the channel (PSID, IGSID, WhatsApp number). */
      senderId: string;
      messageId: string;
      at: Date;
      type: 'text' | 'image' | 'file';
      text: string;
      attachments: { url: string; contentType?: string; name?: string }[];
      /** WhatsApp sends the customer's profile name with each message. */
      profileName?: string;
    }
  | {
      /** A message the business sent from somewhere else (Meta Business Suite, the phone app). */
      kind: 'echo';
      channelType: MetaChannelType;
      accountId: string;
      recipientId: string;
      messageId: string;
      at: Date;
      text: string;
      appId?: string;
    }
  | {
      kind: 'status';
      channelType: MetaChannelType;
      accountId: string;
      /** The message the status is about; Messenger read and delivery events carry a time instead. */
      messageId?: string;
      /** Customer id, for Messenger watermarks. */
      contactId?: string;
      status: 'delivered' | 'read' | 'failed' | 'sent';
      /** Messenger: every message sent before this time is delivered or read. */
      watermark?: Date;
      error?: string;
    };

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Messenger and Instagram send ms timestamps, WhatsApp seconds (as a string). */
function msTime(v: unknown): Date {
  const n = num(v);
  return n ? new Date(n) : new Date();
}

function secTime(v: unknown): Date {
  const n = typeof v === 'string' ? Number(v) : num(v);
  return n && Number.isFinite(n) ? new Date(n * 1000) : new Date();
}

/** Messenger and Instagram `messaging` items (same shape for both). */
function parseMessaging(
  channelType: 'messenger' | 'instagram',
  entryId: string,
  m: Json,
): MetaEvent[] {
  const sender = str(isObj(m.sender) ? m.sender.id : undefined);
  const recipient = str(isObj(m.recipient) ? m.recipient.id : undefined);
  const at = msTime(m.timestamp);

  if (isObj(m.message)) {
    const msg = m.message;
    const mid = str(msg.mid);
    if (!mid || !sender || !recipient) return [];
    if (msg.is_echo === true)
      return [
        {
          kind: 'echo',
          channelType,
          accountId: sender,
          recipientId: recipient,
          messageId: mid,
          at,
          text: str(msg.text) ?? '',
          ...(num(msg.app_id) !== undefined
            ? { appId: String(msg.app_id) }
            : str(msg.app_id)
              ? { appId: str(msg.app_id)! }
              : {}),
        },
      ];
    // Reactions, unsends and deleted messages are not new messages.
    if (msg.is_deleted === true || msg.is_unsupported === true) return [];
    const attachments: { url: string; contentType?: string; name?: string }[] = [];
    let type: 'text' | 'image' | 'file' = 'text';
    for (const a of arr(msg.attachments)) {
      if (!isObj(a)) continue;
      const kind = str(a.type);
      const url = str(isObj(a.payload) ? a.payload.url : undefined);
      if (!url) continue;
      if (kind === 'image') {
        if (type === 'text') type = 'image';
        attachments.push({ url, contentType: 'image/*' });
      } else {
        type = 'file';
        attachments.push({ url, ...(kind ? { name: kind } : {}) });
      }
    }
    const text = str(msg.text) ?? '';
    if (!text && attachments.length === 0) return [];
    return [
      {
        kind: 'message',
        channelType,
        accountId: recipient,
        senderId: sender,
        messageId: mid,
        at,
        type,
        text,
        attachments,
      },
    ];
  }

  // A tap on a button or menu item reads like the customer typed its title.
  if (isObj(m.postback) && sender && recipient) {
    const title = str(m.postback.title) ?? str(m.postback.payload);
    const mid = str(m.postback.mid) ?? `postback:${sender}:${at.getTime()}`;
    if (!title) return [];
    return [
      {
        kind: 'message',
        channelType,
        accountId: recipient,
        senderId: sender,
        messageId: mid,
        at,
        type: 'text',
        text: title,
        attachments: [],
      },
    ];
  }

  if ((isObj(m.delivery) || isObj(m.read)) && sender) {
    const d = (isObj(m.read) ? m.read : m.delivery) as Json;
    const watermark = num(d.watermark);
    const mids = arr(d.mids)
      .map(str)
      .filter((x): x is string => Boolean(x));
    const status = isObj(m.read) ? 'read' : 'delivered';
    const account = recipient ?? entryId;
    if (mids.length)
      return mids.map((messageId) => ({
        kind: 'status' as const,
        channelType,
        accountId: account,
        messageId,
        contactId: sender,
        status,
      }));
    if (watermark)
      return [
        {
          kind: 'status',
          channelType,
          accountId: account,
          contactId: sender,
          status,
          watermark: new Date(watermark),
        },
      ];
  }
  return [];
}

/** WhatsApp Cloud API `changes[].value` with field "messages". */
function parseWhatsApp(value: Json): MetaEvent[] {
  const metadata = isObj(value.metadata) ? value.metadata : {};
  const accountId = str(metadata.phone_number_id);
  if (!accountId) return [];
  const names = new Map<string, string>();
  for (const c of arr(value.contacts))
    if (isObj(c) && str(c.wa_id) && isObj(c.profile) && str(c.profile.name))
      names.set(c.wa_id as string, c.profile.name as string);

  const events: MetaEvent[] = [];
  for (const m of arr(value.messages)) {
    if (!isObj(m)) continue;
    const from = str(m.from);
    const id = str(m.id);
    if (!from || !id) continue;
    const kind = str(m.type) ?? '';
    let text: string;
    let type: 'text' | 'image' | 'file' = 'text';
    const attachments: { url: string; contentType?: string; name?: string }[] = [];
    switch (kind) {
      case 'text':
        text = str(isObj(m.text) ? m.text.body : undefined) ?? '';
        break;
      case 'button':
        text = str(isObj(m.button) ? m.button.text : undefined) ?? '';
        break;
      case 'interactive': {
        const i = isObj(m.interactive) ? m.interactive : {};
        const reply = isObj(i.button_reply)
          ? i.button_reply
          : isObj(i.list_reply)
            ? i.list_reply
            : {};
        text = str(reply.title) ?? '';
        break;
      }
      case 'image':
      case 'sticker': {
        // Media needs an authorised download; the inbox shows that a photo arrived.
        type = 'image';
        const media = isObj(m[kind]) ? m[kind] : {};
        text = str(media.caption) ?? '';
        break;
      }
      case 'document':
      case 'audio':
      case 'video': {
        type = 'file';
        const media = isObj(m[kind]) ? m[kind] : {};
        text = str(media.caption) ?? str(media.filename) ?? '';
        break;
      }
      case 'location': {
        const loc = isObj(m.location) ? m.location : {};
        const parts = [str(loc.name), str(loc.address)].filter(Boolean);
        const lat = num(loc.latitude);
        const lng = num(loc.longitude);
        text = [
          'Shared a location',
          parts.join(', '),
          lat !== undefined && lng !== undefined ? `https://maps.google.com/?q=${lat},${lng}` : '',
        ]
          .filter(Boolean)
          .join(': ');
        break;
      }
      default:
        // Reactions, contacts cards, orders, unsupported types.
        continue;
    }
    if (!text && type === 'text') continue;
    events.push({
      kind: 'message',
      channelType: 'whatsapp',
      accountId,
      senderId: from,
      messageId: id,
      at: secTime(m.timestamp),
      type,
      text,
      attachments,
      ...(names.get(from) ? { profileName: names.get(from)! } : {}),
    });
  }

  for (const s of arr(value.statuses)) {
    if (!isObj(s)) continue;
    const id = str(s.id);
    const status = str(s.status);
    if (!id || !status || !['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
    const firstError = arr(s.errors).find(isObj);
    events.push({
      kind: 'status',
      channelType: 'whatsapp',
      accountId,
      messageId: id,
      status: status as 'sent' | 'delivered' | 'read' | 'failed',
      ...(status === 'failed'
        ? {
            error:
              str(firstError?.title) ??
              str(isObj(firstError?.error_data) ? firstError.error_data.details : undefined) ??
              'WhatsApp could not deliver this message',
          }
        : {}),
    });
  }
  return events;
}

/**
 * Turns a webhook body into events. Unknown objects and shapes are skipped rather than
 * failing the delivery, so one odd event never makes Meta retry the whole batch forever.
 */
export function parseMetaWebhook(body: unknown): MetaEvent[] {
  if (!isObj(body)) return [];
  const object = str(body.object);
  const events: MetaEvent[] = [];
  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;
    const entryId = str(entry.id) ?? '';
    if (object === 'page' || object === 'instagram') {
      const type = object === 'page' ? 'messenger' : 'instagram';
      for (const m of arr(entry.messaging))
        if (isObj(m)) events.push(...parseMessaging(type, entryId, m));
    } else if (object === 'whatsapp_business_account') {
      for (const change of arr(entry.changes))
        if (isObj(change) && change.field === 'messages' && isObj(change.value))
          events.push(...parseWhatsApp(change.value));
    }
  }
  return events;
}
