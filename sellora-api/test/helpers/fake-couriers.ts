export type FakeProvider = 'steadfast' | 'pathao' | 'redx';

export interface CourierRequest {
  provider: FakeProvider;
  /** The API base the request went to (production or sandbox). */
  base: string;
  method: string;
  /** Path after the API base, e.g. "/create_order". */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export interface FakeParcel {
  provider: FakeProvider;
  /** Steadfast consignment id, Pathao consignment id or RedX tracking id. */
  id: string;
  trackingCode: string;
  invoice: string;
  /** The courier's own status word. */
  status: string;
  /** Which merchant account made it (API key, username or token). */
  owner: string;
  body: Record<string, unknown>;
}

/**
 * What the next booking call does instead of answering normally:
 * - lose-reply: the courier makes the parcel, then the connection drops;
 * - network: the request never arrives;
 * - timeout: no answer in time (nothing made);
 * - a number: answer with that HTTP status and nothing made.
 */
export type BookingFault = 'lose-reply' | 'network' | 'timeout' | number;

export const STEADFAST_BASE = 'https://portal.packzy.com/api/v1';
export const PATHAO_BASE = 'https://api-hermes.pathao.com';
export const PATHAO_SANDBOX = 'https://courier-api-sandbox.pathao.com';
export const REDX_BASE = 'https://openapi.redx.com.bd/v1.0.0-beta';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: 'ECONNRESET' });
const timeoutError = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/**
 * Plays Steadfast, Pathao and RedX for tests, following the request and response shapes
 * of their merchant APIs as published in their SDKs. It proves our side of the contract;
 * it is not the couriers.
 */
export class FakeCouriers {
  readonly requests: CourierRequest[] = [];
  readonly parcels: FakeParcel[] = [];
  readonly steadfastAccounts = new Map<string, { secretKey: string; balance: number }>();
  readonly pathaoClients: {
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
    stores: { store_id: number; store_name: string; store_address: string }[];
  }[] = [];
  /** Pathao tokens that work, by token, with the username they belong to. */
  readonly pathaoTokens = new Map<string, string>();
  pathaoTokensIssued = 0;
  readonly redxTokens = new Map<string, { id: number; name: string; address: string }[]>();
  readonly pathaoCities = [
    { city_id: 1, city_name: 'Dhaka' },
    { city_id: 2, city_name: 'Chattogram' },
  ];
  readonly pathaoZones: Record<number, { zone_id: number; zone_name: string }[]> = {
    1: [
      { zone_id: 11, zone_name: 'Dhanmondi' },
      { zone_id: 12, zone_name: 'Mirpur' },
    ],
  };
  readonly pathaoAreas: Record<
    number,
    { area_id: number; area_name: string; home_delivery_available: boolean }[]
  > = {
    11: [
      { area_id: 111, area_name: 'Road 27', home_delivery_available: true },
      { area_id: 112, area_name: 'Jigatola', home_delivery_available: false },
    ],
  };
  readonly redxAreas = [
    { id: 1, name: 'Mohammadpur', post_code: 1207, division_name: 'Dhaka', zone_id: 1 },
    { id: 2, name: 'Dhanmondi', post_code: 1209, division_name: 'Dhaka', zone_id: 1 },
    { id: 3, name: 'Agrabad', post_code: 4100, division_name: 'Chattogram', zone_id: 2 },
  ];
  private faults: { provider: FakeProvider; fault: BookingFault }[] = [];
  private seq = 0;

  /** The next booking with `provider` misbehaves as described. */
  failNextBooking(provider: FakeProvider, fault: BookingFault): void {
    this.faults.push({ provider, fault });
  }

  /** Moves a parcel on the courier's side. */
  setStatus(id: string, status: string): void {
    const p = this.parcels.find((x) => x.id === id || x.invoice === id);
    if (!p) throw new Error(`No fake parcel ${id}`);
    p.status = status;
  }

  /** Every Pathao token stops working (they expired). */
  expirePathaoTokens(): void {
    this.pathaoTokens.clear();
  }

  bookings(provider: FakeProvider): CourierRequest[] {
    const path = { steadfast: '/create_order', pathao: '/aladdin/api/v1/orders', redx: '/parcel' }[
      provider
    ];
    return this.requests.filter(
      (r) => r.provider === provider && r.method === 'POST' && r.path === path,
    );
  }

  reset(): void {
    this.requests.length = 0;
    this.faults = [];
  }

  /** The fetch to hand to the app. Thrown errors become rejections, as with a real fetch. */
  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    try {
      return Promise.resolve(this.route(input, init));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

  private route(input: string | URL | Request, init?: RequestInit): Response {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const method = init?.method ?? 'GET';
    const query = Object.fromEntries(url.searchParams.entries());
    const href = url.href;
    for (const [provider, base] of [
      ['steadfast', STEADFAST_BASE],
      ['pathao', PATHAO_BASE],
      ['pathao', PATHAO_SANDBOX],
      ['redx', REDX_BASE],
    ] as const) {
      if (!href.startsWith(base)) continue;
      const path = url.pathname.slice(new URL(base).pathname.replace(/\/$/, '').length) || '/';
      const req = { provider, base, method, path, query, headers, body };
      this.requests.push(req);
      if (provider === 'steadfast') return this.steadfast(req);
      if (provider === 'pathao') return this.pathao(req);
      return this.redx(req);
    }
    throw new Error(`FakeCouriers: unexpected request to ${href}`);
  }

  /** Applies a queued fault to a booking; returns a response, throws, or null to go on. */
  private fault(provider: FakeProvider, make: () => void): Response | null {
    const i = this.faults.findIndex((f) => f.provider === provider);
    if (i < 0) return null;
    const { fault } = this.faults.splice(i, 1)[0]!;
    if (fault === 'lose-reply') {
      make();
      throw networkError();
    }
    if (fault === 'network') throw networkError();
    if (fault === 'timeout') throw timeoutError();
    return json({ message: 'Fake courier failure' }, fault);
  }

  // ---------------------------------------------------------------- Steadfast

  private steadfast(req: CourierRequest): Response {
    const account = this.steadfastAccounts.get(req.headers['api-key'] ?? '');
    if (!account || account.secretKey !== req.headers['secret-key'])
      return json({ message: 'Unauthorized' }, 401);
    const owner = req.headers['api-key']!;
    if (req.method === 'GET' && req.path === '/get_balance')
      return json({ status: 200, current_balance: account.balance });

    if (req.method === 'POST' && req.path === '/create_order') {
      const b = req.body ?? {};
      const errors: Record<string, string[]> = {};
      if (!/^01\d{9}$/.test(String(b.recipient_phone)))
        errors.recipient_phone = ['The recipient phone must be 11 digits.'];
      if (String(b.recipient_address).includes('REJECT'))
        errors.recipient_address = ['The recipient address is invalid.'];
      if (
        this.parcels.some(
          (p) => p.provider === 'steadfast' && p.owner === owner && p.invoice === b.invoice,
        )
      )
        errors.invoice = ['The invoice has already been taken.'];
      if (Object.keys(errors).length) return json({ message: 'Validation failed', errors }, 422);
      this.seq += 1;
      const parcel: FakeParcel = {
        provider: 'steadfast',
        id: String(1_000_000 + this.seq),
        trackingCode: `SF${(1000 + this.seq).toString(36).toUpperCase()}X`,
        invoice: String(b.invoice),
        status: 'in_review',
        owner,
        body: b,
      };
      const faulted = this.fault('steadfast', () => this.parcels.push(parcel));
      if (faulted) return faulted;
      this.parcels.push(parcel);
      return json({
        status: 200,
        message: 'Consignment has been created successfully.',
        consignment: {
          consignment_id: Number(parcel.id),
          invoice: parcel.invoice,
          tracking_code: parcel.trackingCode,
          recipient_name: b.recipient_name,
          recipient_phone: b.recipient_phone,
          recipient_address: b.recipient_address,
          cod_amount: b.cod_amount,
          status: 'in_review',
          note: b.note ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });
    }
    const byCid = /^\/status_by_cid\/(.+)$/.exec(req.path);
    const byInvoice = /^\/status_by_invoice\/(.+)$/.exec(req.path);
    if (req.method === 'GET' && (byCid || byInvoice)) {
      const key = decodeURIComponent((byCid ?? byInvoice)![1]!);
      const p = this.parcels.find(
        (x) =>
          x.provider === 'steadfast' &&
          x.owner === owner &&
          (byCid ? x.id === key : x.invoice === key),
      );
      if (!p) return json({ status: 404, message: 'Consignment not found.' }, 404);
      return json({ status: 200, delivery_status: p.status });
    }
    return json({ message: 'Not found' }, 404);
  }

  // ---------------------------------------------------------------- Pathao

  private pathao(req: CourierRequest): Response {
    const api = '/aladdin/api/v1';
    if (req.method === 'POST' && req.path === `${api}/issue-token`) {
      const b = req.body ?? {};
      const client = this.pathaoClients.find(
        (c) =>
          c.clientId === b.client_id &&
          c.clientSecret === b.client_secret &&
          c.username === b.username &&
          c.password === b.password,
      );
      if (b.grant_type !== 'password' || !client)
        return json(
          { message: 'The user credentials were incorrect.', type: 'error', code: 400 },
          400,
        );
      this.pathaoTokensIssued += 1;
      const token = `pathao-token-${this.pathaoTokensIssued}-${Math.random().toString(36).slice(2)}`;
      this.pathaoTokens.set(token, client.username);
      return json({
        token_type: 'Bearer',
        expires_in: 432_000,
        access_token: token,
        refresh_token: `r-${token}`,
      });
    }
    const auth = req.headers.authorization ?? '';
    const username = this.pathaoTokens.get(auth.replace(/^Bearer /, ''));
    if (!username) return json({ message: 'Unauthenticated.' }, 401);
    const client = this.pathaoClients.find((c) => c.username === username)!;

    if (req.method === 'GET' && req.path === `${api}/stores`)
      return json({
        code: 200,
        type: 'success',
        data: {
          data: client.stores.map((s) => ({ ...s, is_active: 1 })),
          total: client.stores.length,
        },
      });
    if (req.method === 'GET' && req.path === `${api}/city-list`)
      return json({ code: 200, data: { data: this.pathaoCities } });
    const zones = new RegExp(`^${api}/cities/(\\d+)/zone-list$`).exec(req.path);
    if (req.method === 'GET' && zones)
      return json({ code: 200, data: { data: this.pathaoZones[Number(zones[1])] ?? [] } });
    const areas = new RegExp(`^${api}/zones/(\\d+)/area-list$`).exec(req.path);
    if (req.method === 'GET' && areas)
      return json({ code: 200, data: { data: this.pathaoAreas[Number(areas[1])] ?? [] } });

    if (req.method === 'POST' && req.path === `${api}/orders`) {
      const b = req.body ?? {};
      const errors: Record<string, string[]> = {};
      if (!client.stores.some((s) => s.store_id === b.store_id))
        errors.store_id = ['The selected store id is invalid.'];
      if (!/^01\d{9}$/.test(String(b.recipient_phone)))
        errors.recipient_phone = ['The recipient phone format is invalid.'];
      if (String(b.recipient_address).length < 10)
        errors.recipient_address = ['The recipient address must be at least 10 characters.'];
      if (!Number.isInteger(b.amount_to_collect))
        errors.amount_to_collect = ['The amount to collect must be an integer.'];
      const weight = Number(b.item_weight);
      if (!(weight >= 0.5 && weight <= 10))
        errors.item_weight = ['The item weight must be between 0.5 and 10.'];
      if (Object.keys(errors).length)
        return json(
          { message: 'Please fix the given errors', type: 'error', code: 422, errors },
          422,
        );
      this.seq += 1;
      const id = `DL${String(this.seq).padStart(6, '0')}PTH`;
      const parcel: FakeParcel = {
        provider: 'pathao',
        id,
        trackingCode: id,
        invoice: String(b.merchant_order_id),
        status: 'Pending',
        owner: username,
        body: b,
      };
      const faulted = this.fault('pathao', () => this.parcels.push(parcel));
      if (faulted) return faulted;
      this.parcels.push(parcel);
      return json({
        message: 'Order Created Successfully',
        type: 'success',
        code: 200,
        data: {
          consignment_id: id,
          merchant_order_id: b.merchant_order_id,
          order_status: 'Pending',
          delivery_fee: 80,
        },
      });
    }
    const info = new RegExp(`^${api}/orders/([^/]+)/info$`).exec(req.path);
    if (req.method === 'GET' && info) {
      const p = this.parcels.find(
        (x) =>
          x.provider === 'pathao' && x.owner === username && x.id === decodeURIComponent(info[1]!),
      );
      if (!p) return json({ message: 'Order not found', type: 'error', code: 404 }, 404);
      return json({
        message: 'Order info',
        type: 'success',
        code: 200,
        data: {
          consignment_id: p.id,
          merchant_order_id: p.invoice,
          order_status: p.status.replace(/_/g, ' '),
          order_status_slug: p.status,
          updated_at: '2026-10-28 12:00:00',
          invoice_id: null,
        },
      });
    }
    return json({ message: 'Not found' }, 404);
  }

  // ---------------------------------------------------------------- RedX

  private redx(req: CourierRequest): Response {
    const token = (req.headers['api-access-token'] ?? '').replace(/^Bearer /, '');
    const stores = this.redxTokens.get(token);
    if (!stores) return json({ message: 'Unauthorized' }, 401);
    if (req.method === 'GET' && req.path === '/pickup/stores')
      return json({ pickup_stores: stores });
    if (req.method === 'GET' && req.path === '/areas') {
      const areas = req.query.post_code
        ? this.redxAreas.filter((a) => String(a.post_code) === req.query.post_code)
        : this.redxAreas;
      return json({ areas });
    }
    if (req.method === 'POST' && req.path === '/parcel') {
      const b = req.body ?? {};
      if (!this.redxAreas.some((a) => a.id === b.delivery_area_id && a.name === b.delivery_area))
        return json({ message: 'Invalid delivery area' }, 400);
      if (typeof b.cash_collection_amount !== 'string')
        return json({ message: 'cash_collection_amount must be a string' }, 400);
      this.seq += 1;
      const id = `261028A${String(this.seq).padStart(4, '0')}RX`;
      const parcel: FakeParcel = {
        provider: 'redx',
        id,
        trackingCode: id,
        invoice: String(b.merchant_invoice_id),
        status: 'pickup-pending',
        owner: token,
        body: b,
      };
      const faulted = this.fault('redx', () => this.parcels.push(parcel));
      if (faulted) return faulted;
      this.parcels.push(parcel);
      return json({ tracking_id: id });
    }
    const parcelInfo = /^\/parcel\/info\/(.+)$/.exec(req.path);
    if (req.method === 'GET' && parcelInfo) {
      const p = this.parcels.find(
        (x) =>
          x.provider === 'redx' && x.owner === token && x.id === decodeURIComponent(parcelInfo[1]!),
      );
      if (!p) return json({ message: 'Parcel not found' }, 404);
      return json({
        parcel: { tracking_id: p.id, status: p.status, merchant_invoice_id: p.invoice },
      });
    }
    return json({ message: 'Not found' }, 404);
  }
}
