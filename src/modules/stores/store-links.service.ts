import { Injectable } from '@nestjs/common';
import { hmacSha256 } from '../../common/crypto/tokens.js';
import { AppConfig } from '../../config/app-config.js';
import { UrlSigner } from '../../infra/storage/signing.js';
import { storeHost, storeUrl } from './store-hosts.js';

/** A store preview link works for an hour. */
export const PREVIEW_TTL_S = 3600;
/** An order receipt link keeps working for 90 days. */
export const RECEIPT_TTL_S = 90 * 86_400;

/** What a store's address depends on. */
export interface StoreAddress {
  handle: string;
  primaryDomain?: string | null;
}

interface PreviewClaims {
  t: 'preview';
  s: string;
  exp: number;
}

/** What a landing page preview shows: the business's draft or the snapshot under review. */
/** What a landing preview shows: the draft, the version in review, the scheduled one, or B. */
export const LANDING_PREVIEW_KINDS = ['draft', 'submission', 'scheduled', 'ab_test'] as const;
export type LandingPreviewKind = (typeof LANDING_PREVIEW_KINDS)[number];

interface LandingPreviewClaims {
  t: 'landing_preview';
  p: string;
  k: LandingPreviewKind;
  exp: number;
}

interface ReceiptClaims {
  t: 'receipt';
  s: string;
  o: string;
  exp: number;
}

/**
 * Addresses and signed links for stores. Preview links let a business (or a reviewer) see a
 * store before it opens; receipt links let a shopper see the order they just placed. Both
 * are signed with keys derived from STOREFRONT_API_KEY, so without it neither exists.
 */
@Injectable()
export class StoreLinksService {
  private readonly preview: UrlSigner | null;
  private readonly receipt: UrlSigner | null;

  constructor(private readonly config: AppConfig) {
    const key = config.get('STOREFRONT_API_KEY');
    this.preview = key ? new UrlSigner(hmacSha256(key, 'sellora:store-preview')) : null;
    this.receipt = key ? new UrlSigner(hmacSha256(key, 'sellora:order-receipt')) : null;
  }

  /** Whether the storefront is configured at all (STOREFRONT_API_KEY set). */
  get enabled(): boolean {
    return this.preview !== null;
  }

  baseDomain(): string {
    return this.config.get('STOREFRONT_BASE_DOMAIN');
  }

  /** The port store addresses carry in development (":3100"), or "". */
  devPort(): string {
    return /:\d+$/.exec(this.baseDomain())?.[0] ?? '';
  }

  /** The store's Sellora address (its subdomain). */
  host(handle: string): string {
    return storeHost(handle, this.baseDomain());
  }

  /** A custom domain as shoppers' browsers send it (with the development port, if any). */
  domainHost(domain: string): string {
    return `${domain}${this.devPort()}`;
  }

  /** The Sellora address as a URL; previews always use it. */
  subdomainUrl(handle: string): string {
    return storeUrl(handle, this.baseDomain(), this.config.get('STOREFRONT_URL_SCHEME'));
  }

  /** Where the store lives for shoppers: its main custom domain, or its Sellora address. */
  url(store: StoreAddress): string {
    return store.primaryDomain
      ? `${this.config.get('STOREFRONT_URL_SCHEME')}://${this.domainHost(store.primaryDomain)}`
      : this.subdomainUrl(store.handle);
  }

  previewUrl(
    storeId: string,
    handle: string,
    now = Date.now(),
  ): { url: string; expiresAt: string } {
    if (!this.preview) throw new Error('Store previews need STOREFRONT_API_KEY');
    const exp = Math.floor(now / 1000) + PREVIEW_TTL_S;
    const token = this.preview.sign({ t: 'preview', s: storeId, exp });
    return {
      url: `${this.subdomainUrl(handle)}/__preview?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** The store id a preview token opens, or null when it is invalid or expired. */
  verifyPreview(token: string | undefined): string | null {
    if (!token || !this.preview) return null;
    const claims = this.preview.verify<PreviewClaims>(token);
    return claims?.t === 'preview' && typeof claims.s === 'string' ? claims.s : null;
  }

  /** A one-hour link to a landing page's draft (or its snapshot under review), on the subdomain. */
  landingPreviewUrl(
    page: { id: string; slug: string },
    handle: string,
    kind: LandingPreviewKind,
    now = Date.now(),
  ): { url: string; expiresAt: string } {
    if (!this.preview) throw new Error('Landing page previews need STOREFRONT_API_KEY');
    const exp = Math.floor(now / 1000) + PREVIEW_TTL_S;
    const token = this.preview.sign({ t: 'landing_preview', p: page.id, k: kind, exp });
    return {
      url: `${this.subdomainUrl(handle)}/${page.slug}?preview=${encodeURIComponent(token)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** The landing page and version a preview token shows, or null. */
  verifyLandingPreview(
    token: string | undefined,
  ): { pageId: string; kind: LandingPreviewKind } | null {
    if (!token || !this.preview) return null;
    const claims = this.preview.verify<LandingPreviewClaims>(token);
    return claims?.t === 'landing_preview' &&
      typeof claims.p === 'string' &&
      (LANDING_PREVIEW_KINDS as readonly string[]).includes(claims.k)
      ? { pageId: claims.p, kind: claims.k }
      : null;
  }

  receiptToken(storeId: string, orderId: string, now = Date.now()): string {
    if (!this.receipt) throw new Error('Order receipts need STOREFRONT_API_KEY');
    return this.receipt.sign({
      t: 'receipt',
      s: storeId,
      o: orderId,
      exp: Math.floor(now / 1000) + RECEIPT_TTL_S,
    });
  }

  /** The order id a receipt token shows for this store, or null. */
  verifyReceipt(storeId: string, token: string): string | null {
    if (!this.receipt) return null;
    const claims = this.receipt.verify<ReceiptClaims>(token);
    return claims?.t === 'receipt' && claims.s === storeId && typeof claims.o === 'string'
      ? claims.o
      : null;
  }
}
