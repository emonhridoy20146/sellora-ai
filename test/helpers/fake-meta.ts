import { createHash, createHmac } from 'node:crypto';

export interface GraphRequest {
  method: string;
  /** Path after the version, e.g. "1029384756/messages". */
  path: string;
  version: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  token: string | null;
}

export interface FakePage {
  id: string;
  name: string;
  token: string;
  tasks?: string[];
  instagram?: { id: string; username: string };
}

export interface FakeWhatsApp {
  phoneNumberId: string;
  wabaId: string;
  token: string;
  displayPhone: string;
  verifiedName: string;
}

/** A file on Meta's side: a CDN photo (Messenger, Instagram) or WhatsApp media. */
export interface FakeMedia {
  bytes: Buffer;
  contentType: string;
  /** Answer with this status instead (403 = expired link, 500 = outage). */
  status?: number;
  /** Answer with a redirect to this URL instead. */
  redirect?: string;
}

export interface FakeWhatsAppMedia extends FakeMedia {
  /** The token that may read it (the phone number's). */
  token: string;
  /** Overrides the checksum Meta reports, to simulate a corrupted download. */
  sha256?: string;
}

/** Where WhatsApp media downloads live (Meta's lookaside host). */
export const whatsappMediaUrl = (mediaId: string) =>
  `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId}&ext=1&hash=AT_test`;

interface Scripted {
  match: RegExp;
  method: string;
  status: number;
  error: Record<string, unknown>;
  times: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const graphError = (status: number, error: Record<string, unknown>) =>
  json({ error: { type: 'OAuthException', fbtrace_id: 'Atrace', ...error } }, status);

/**
 * Plays the Graph API for tests: Facebook Login's code exchange, the page list, webhook
 * subscriptions, the Send API, WhatsApp Cloud API sends, profile lookups, and the files
 * behind photo messages (CDN links, WhatsApp media). Like Meta, it insists on a bearer token
 * with a matching appsecret_proof. It proves our side of the contract; it is not Meta.
 */
export class FakeGraph {
  readonly requests: GraphRequest[] = [];
  /** Login codes the fake accepts, mapped to the user token they produce. */
  readonly codes = new Map<string, string>();
  /** Pages each user token can see. */
  readonly pagesByUser = new Map<string, FakePage[]>();
  readonly whatsapp: FakeWhatsApp[] = [];
  /** Embedded Signup codes, mapped to the business token they produce. */
  readonly businessCodes = new Map<string, string>();
  readonly profiles = new Map<string, Record<string, string>>();
  /** Files on Meta's CDN, by full https URL. */
  readonly cdn = new Map<string, FakeMedia>();
  /** WhatsApp media, by media id. */
  readonly waMedia = new Map<string, FakeWhatsAppMedia>();
  /** Every download from a CDN or media host, with the token it carried. */
  readonly downloads: { url: string; token: string | null }[] = [];
  private scripted: Scripted[] = [];
  private seq = 0;
  /** Delay before each Send API answer, to hold a message "on its way". */
  sendDelayMs = 0;

  constructor(private readonly appSecret: string) {}

  reset(): void {
    this.requests.length = 0;
    this.downloads.length = 0;
    this.scripted = [];
  }

  /** The next `times` calls matching `method path` answer with this Graph error. */
  fail(method: string, match: RegExp, status: number, error: Record<string, unknown>, times = 1) {
    this.scripted.push({ method, match, status, error, times });
  }

  sent(): GraphRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages'));
  }

  private tokens(): Set<string> {
    const all = new Set<string>();
    for (const t of this.codes.values()) all.add(`${t}-long`);
    for (const pages of this.pagesByUser.values()) for (const p of pages) all.add(p.token);
    for (const w of this.whatsapp) all.add(w.token);
    for (const t of this.businessCodes.values()) all.add(t);
    return all;
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const [, version = '', ...rest] = url.pathname.split('/');
    const path = rest.join('/');
    const method = (init?.method ?? 'GET').toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    // The Graph API is on the configured base URL (plain http in tests); media is on https hosts.
    if (url.protocol === 'https:') return this.media(url, token);
    this.requests.push({ method, path, version, query, body, token });

    if (path === 'oauth/access_token') return this.oauth(query);

    if (!token) return graphError(400, { code: 104, message: 'An access token is required' });
    const proof = createHmac('sha256', this.appSecret).update(token).digest('hex');
    if (query.appsecret_proof !== proof)
      return graphError(400, {
        code: 100,
        message: 'Invalid appsecret_proof provided in the API argument',
      });
    if (!this.tokens().has(token))
      return graphError(400, {
        code: 190,
        message: 'Invalid OAuth access token - Cannot parse access token',
      });

    const scripted = this.scripted.find(
      (s) => s.method === method && s.match.test(path) && s.times > 0,
    );
    if (scripted) {
      scripted.times -= 1;
      return graphError(scripted.status, scripted.error);
    }
    return this.route(method, path, query, body, token);
  }) as typeof fetch;

  private media(url: URL, token: string | null): Response {
    this.downloads.push({ url: url.toString(), token });
    let file: FakeMedia | undefined;
    if (url.hostname === 'lookaside.fbsbx.com') {
      const wa = this.waMedia.get(url.searchParams.get('mid') ?? '');
      if (wa && wa.token !== token) return new Response('Unauthorized', { status: 401 });
      file = wa;
    } else file = this.cdn.get(url.toString());
    if (!file) return new Response('Not found', { status: 404 });
    if (file.redirect)
      return new Response(null, { status: 302, headers: { location: file.redirect } });
    if (file.status) return new Response('No', { status: file.status });
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: { 'content-type': file.contentType, 'content-length': String(file.bytes.length) },
    });
  }

  private oauth(q: Record<string, string>): Response {
    if (q.grant_type === 'fb_exchange_token') {
      if (!q.fb_exchange_token) return graphError(400, { code: 100, message: 'Missing token' });
      return json({
        access_token: `${q.fb_exchange_token}-long`,
        token_type: 'bearer',
        expires_in: 5_183_944,
      });
    }
    if (!q.client_secret || !q.code)
      return graphError(400, { code: 100, message: 'Missing parameter' });
    if (!q.redirect_uri) {
      const business = this.businessCodes.get(q.code);
      if (!business)
        return graphError(400, { code: 100, error_subcode: 36007, message: 'Invalid code' });
      return json({ access_token: business, token_type: 'bearer' });
    }
    const user = this.codes.get(q.code);
    if (!user)
      return graphError(400, {
        code: 100,
        error_subcode: 36009,
        message: 'This authorization code has been used',
      });
    return json({ access_token: user, token_type: 'bearer', expires_in: 5_183_944 });
  }

  private async route(
    method: string,
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown> | null,
    token: string,
  ): Promise<Response> {
    const parts = path.split('/');
    if (method === 'GET' && path === 'me/accounts') {
      const user = token.replace(/-long$/, '');
      const pages = this.pagesByUser.get(user) ?? [];
      return json({
        data: pages.map((p) => ({
          id: p.id,
          name: p.name,
          access_token: p.token,
          tasks: p.tasks ?? [
            'ADVERTISE',
            'ANALYZE',
            'CREATE_CONTENT',
            'MESSAGING',
            'MODERATE',
            'MANAGE',
          ],
          ...(p.instagram
            ? { instagram_business_account: { id: p.instagram.id, username: p.instagram.username } }
            : {}),
        })),
      });
    }
    if (parts[1] === 'subscribed_apps') return json({ success: true });

    if (method === 'POST' && parts[1] === 'messages') {
      if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
      this.seq += 1;
      if (body?.messaging_product === 'whatsapp')
        return json({
          messaging_product: 'whatsapp',
          contacts: [{ input: body.to, wa_id: body.to }],
          messages: [{ id: `wamid.OUT${this.seq}` }],
        });
      const recipient = (body?.recipient as { id?: string } | undefined)?.id;
      if (!recipient)
        return graphError(400, { code: 100, message: 'param recipient must be non-empty' });
      return json({ recipient_id: recipient, message_id: `m_out_${this.seq}` });
    }

    if (method === 'GET' && parts.length === 2 && parts[1] === 'phone_numbers') {
      const numbers = this.whatsapp.filter((w) => w.wabaId === parts[0] && w.token === token);
      return json({ data: numbers.map((w) => ({ id: w.phoneNumberId })) });
    }

    if (method === 'GET' && parts.length === 1) {
      const wa = this.whatsapp.find((w) => w.phoneNumberId === parts[0]);
      if (wa) {
        if (wa.token !== token)
          return graphError(400, {
            code: 100,
            error_subcode: 33,
            message: 'Unsupported get request',
          });
        return json({
          id: wa.phoneNumberId,
          display_phone_number: wa.displayPhone,
          verified_name: wa.verifiedName,
        });
      }
      const media = this.waMedia.get(parts[0]!);
      if (media && media.token === token)
        return json({
          messaging_product: 'whatsapp',
          id: parts[0],
          url: whatsappMediaUrl(parts[0]!),
          mime_type: media.contentType,
          sha256: media.sha256 ?? createHash('sha256').update(media.bytes).digest('hex'),
          file_size: media.bytes.length,
        });
      const profile = this.profiles.get(parts[0]!);
      if (profile) return json({ id: parts[0], ...profile });
      return graphError(400, { code: 100, error_subcode: 33, message: 'Object does not exist' });
    }
    void query;
    return graphError(400, { code: 100, message: `Unknown path ${method} ${path}` });
  }
}

/** Signs a webhook body the way Meta does (X-Hub-Signature-256). */
export function signWebhook(appSecret: string, body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  return { raw, signature: `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}` };
}

/** Webhook bodies in Meta's documented shapes. */
export const webhook = {
  messenger: (pageId: string, psid: string, mid: string, text: string, at = Date.now()) => ({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: at,
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: pageId },
            timestamp: at,
            message: { mid, text },
          },
        ],
      },
    ],
  }),
  messengerPhotos: (pageId: string, psid: string, mid: string, urls: string[], text?: string) => ({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: pageId },
            timestamp: Date.now(),
            message: {
              mid,
              ...(text ? { text } : {}),
              attachments: urls.map((url) => ({ type: 'image', payload: { url } })),
            },
          },
        ],
      },
    ],
  }),
  /** A voice clip recorded in Messenger (Instagram sends the same shape). */
  messengerAudio: (pageId: string, psid: string, mid: string, url: string) => ({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: pageId },
            timestamp: Date.now(),
            message: { mid, attachments: [{ type: 'audio', payload: { url } }] },
          },
        ],
      },
    ],
  }),
  echo: (pageId: string, psid: string, mid: string, text: string, appId?: string) => ({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: pageId },
            recipient: { id: psid },
            timestamp: Date.now(),
            message: { mid, text, is_echo: true, ...(appId ? { app_id: Number(appId) } : {}) },
          },
        ],
      },
    ],
  }),
  read: (pageId: string, psid: string, watermark: number) => ({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: pageId },
            timestamp: watermark,
            read: { watermark },
          },
        ],
      },
    ],
  }),
  instagram: (igId: string, igsid: string, mid: string, text: string) => ({
    object: 'instagram',
    entry: [
      {
        id: igId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: igsid },
            recipient: { id: igId },
            timestamp: Date.now(),
            message: { mid, text },
          },
        ],
      },
    ],
  }),
  whatsapp: (phoneNumberId: string, from: string, id: string, text: string, name = 'Karim') => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '8801700000000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [
                {
                  from,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  }),
  whatsappPhoto: (
    phoneNumberId: string,
    from: string,
    id: string,
    mediaId: string,
    caption?: string,
    mimeType = 'image/jpeg',
  ) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '8801700000000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Karim' }, wa_id: from }],
              messages: [
                {
                  from,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'image',
                  image: {
                    id: mediaId,
                    mime_type: mimeType,
                    sha256: 'meta-sends-its-own-hash',
                    ...(caption ? { caption } : {}),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  }),
  /** A WhatsApp voice note (WhatsApp records Ogg Opus). */
  whatsappVoice: (
    phoneNumberId: string,
    from: string,
    id: string,
    mediaId: string,
    mimeType = 'audio/ogg; codecs=opus',
  ) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '8801700000000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Karim' }, wa_id: from }],
              messages: [
                {
                  from,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'audio',
                  audio: { id: mediaId, mime_type: mimeType, sha256: 'meta-hash', voice: true },
                },
              ],
            },
          },
        ],
      },
    ],
  }),
  whatsappStatus: (phoneNumberId: string, id: string, status: string, error?: string) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '8801700000000', phone_number_id: phoneNumberId },
              statuses: [
                {
                  id,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: '8801711111111',
                  ...(error ? { errors: [{ code: 131026, title: error }] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  }),
};
