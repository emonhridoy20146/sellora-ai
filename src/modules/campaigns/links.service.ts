import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppError } from '../../common/errors/app-error.js';
import { isDuplicateKey } from '../../common/filters/problem-details.filter.js';
import { ProductRepository } from '../commerce/repositories.js';
import { landingStatus, type LandingPage } from '../landing-pages/schemas.js';
import { StoreRepository } from '../stores/repositories.js';
import { StoreLinksService } from '../stores/store-links.service.js';
import { trackingQuery } from './campaign-rules.js';
import { MarketingLinkRepository } from './repositories.js';
import type { LinkChoice, LinkKind, MarketingLink } from './schemas.js';

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_CODE_RE = /^[A-Za-z0-9]{8}$/;
/** Stands in for the code in previews, before the text first goes out. */
const SAMPLE_CODE = 'Ab12Cd34';

function linkCode(): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export interface LinkInput {
  kind: LinkKind;
  storeId?: string;
  targetId?: string;
}

/**
 * The short links in campaign and automation texts (ADR 0019): `<store address>/c/<code>`,
 * counted and sent on with tracking tags by the storefront. Must run inside a tenant scope.
 */
@Injectable()
export class MarketingLinksService {
  constructor(
    private readonly links: MarketingLinkRepository,
    private readonly stores: StoreRepository,
    private readonly storeLinks: StoreLinksService,
    private readonly products: ProductRepository,
    @InjectModel('LandingPage') private readonly landingModel: Model<LandingPage>,
  ) {}

  /** Checks what the business picked and fills in the path and name. Throws a field error. */
  async choose(input: LinkInput | undefined, path = 'link'): Promise<LinkChoice> {
    if (!input || input.kind === 'none') return { kind: 'none' };
    const bad = (message: string) => AppError.validation([{ path, message }]);
    const store =
      input.storeId && Types.ObjectId.isValid(input.storeId)
        ? await this.stores.findById(input.storeId)
        : (await this.stores.find({}, { sort: { _id: 1 }, limit: 1 }))[0];
    if (!store) throw bad('Make your online store first: links go to a page of your store.');
    if (input.kind === 'store')
      return { kind: 'store', storeId: store._id, label: store.name, path: '/' };
    if (!input.targetId || !Types.ObjectId.isValid(input.targetId))
      throw bad(input.kind === 'product' ? 'Choose the product' : 'Choose the landing page');
    if (input.kind === 'landing_page') {
      const page = await this.landingModel
        .findOne({ _id: new Types.ObjectId(input.targetId), orgId: store.orgId })
        .lean()
        .exec();
      if (!page) throw bad('That landing page was not found.');
      if (landingStatus(page) !== 'live') throw bad('That landing page is not live.');
      return {
        kind: 'landing_page',
        storeId: page.storeId,
        targetId: input.targetId,
        label: page.name,
        path: `/${page.slug}`,
      };
    }
    const product = await this.products.findById(input.targetId);
    if (!product) throw bad('That product was not found.');
    if (product.status !== 'active') throw bad('That product is not on sale.');
    return {
      kind: 'product',
      storeId: store._id,
      targetId: input.targetId,
      label: product.name,
      path: `/products/${product.slug}`,
    };
  }

  /** Whether two choices point at the same page (then the short code is kept). */
  same(a: LinkChoice, b: LinkChoice): boolean {
    return (
      a.kind === b.kind &&
      String(a.storeId ?? '') === String(b.storeId ?? '') &&
      (a.path ?? '') === (b.path ?? '')
    );
  }

  /** The store's address for a choice, or null when there is no link. */
  private async base(choice: LinkChoice): Promise<string | null> {
    if (choice.kind === 'none' || !choice.storeId) return null;
    const store = await this.stores.findById(choice.storeId);
    return store ? this.storeLinks.url(store) : null;
  }

  /** The link as a preview shows it (a made-up code until the text first goes out). */
  async previewUrl(choice: LinkChoice): Promise<string> {
    const base = await this.base(choice);
    return base ? `${base}/c/${choice.code ?? SAMPLE_CODE}` : '';
  }

  /**
   * The short link for a choice, making its code the first time. Returns the code too, so
   * the caller can keep it with the campaign or automation.
   */
  async ensure(
    choice: LinkChoice,
    owner: MarketingLink['owner'],
    utm: string,
  ): Promise<{ url: string; code: string } | null> {
    const base = await this.base(choice);
    if (!base || !choice.storeId || !choice.path) return null;
    if (choice.code) return { url: `${base}/c/${choice.code}`, code: choice.code };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const made = await this.links.create({
          code: linkCode(),
          storeId: choice.storeId,
          path: choice.path,
          utm,
          owner,
          clicks: 0,
        });
        return { url: `${base}/c/${made.code}`, code: made.code };
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    throw new Error('Could not make a short link');
  }

  /** Clicks on a short link (0 before it was made). */
  async clicks(code: string | undefined): Promise<{ clicks: number; lastClickAt: string | null }> {
    if (!code) return { clicks: 0, lastClickAt: null };
    const link = await this.links.findOne({ code }, { clicks: 1, lastClickAt: 1 });
    return { clicks: link?.clicks ?? 0, lastClickAt: link?.lastClickAt?.toISOString() ?? null };
  }

  /**
   * The storefront's question: where does this code on this store go? Counts the click.
   * Null when the code is not this store's.
   */
  async open(
    storeId: Types.ObjectId,
    code: string,
  ): Promise<{ path: string; query: Record<string, string> } | null> {
    if (!LINK_CODE_RE.test(code)) return null;
    const link = await this.links.findOneAndUpdate(
      { code, storeId },
      { $inc: { clicks: 1 }, $set: { lastClickAt: new Date() } },
    );
    if (!link) return null;
    return { path: link.path, query: trackingQuery(link.utm) };
  }
}
