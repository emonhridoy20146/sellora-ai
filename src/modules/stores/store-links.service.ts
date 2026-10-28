import { Injectable } from '@nestjs/common';
import { hmacSha256 } from '../../common/crypto/tokens.js';
import { AppConfig } from '../../config/app-config.js';
import { UrlSigner } from '../../infra/storage/signing.js';
import { storeHost, storeUrl } from './store-hosts.js';

/** A store preview link works for an hour. */
export const PREVIEW_TTL_S = 3600;
/** An order receipt link keeps working for 90 days. */
export const RECEIPT_TTL_S = 90 * 86_400;

interface PreviewClaims {
  t: 'preview';
  s: string;
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

  host(handle: string): string {
    return storeHost(handle, this.baseDomain());
  }

  url(handle: string): string {
    return storeUrl(handle, this.baseDomain(), this.config.get('STOREFRONT_URL_SCHEME'));
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
      url: `${this.url(handle)}/__preview?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** The store id a preview token opens, or null when it is invalid or expired. */
  verifyPreview(token: string | undefined): string | null {
    if (!token || !this.preview) return null;
    const claims = this.preview.verify<PreviewClaims>(token);
    return claims?.t === 'preview' && typeof claims.s === 'string' ? claims.s : null;
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
