import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { RequestContext } from '../../common/context/request-context.js';
import { AppError } from '../../common/errors/app-error.js';
import type { WithId } from '../../infra/database/schema-helpers.js';
import { TransactionService } from '../../infra/database/transaction.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ProductRepository, StockMovementRepository } from './repositories.js';
import type { StockMovement, StockReason } from './schemas.js';

export type StockMovementDoc = WithId<StockMovement>;

export interface StockLine {
  productId: string | Types.ObjectId;
  variantId: string | Types.ObjectId;
  quantity: number;
  label?: string;
}

export function toStockMovementDto(m: StockMovementDoc) {
  return {
    id: m._id.toHexString(),
    productId: m.productId.toHexString(),
    variantId: m.variantId.toHexString(),
    delta: m.delta,
    stockAfter: m.stockAfter,
    reason: m.reason,
    reference: m.reference ?? null,
    note: m.note ?? null,
    actor: m.actor,
    at: m.createdAt.toISOString(),
  };
}

/**
 * The only code that changes stock. Each change is one conditional update on the variant
 * (stock can never go below zero for tracked variants) plus a stock movement row, inside a
 * transaction, so concurrent orders cannot oversell and every number can be explained.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly products: ProductRepository,
    private readonly movements: StockMovementRepository,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  private actor() {
    const a = RequestContext.actor();
    return { type: a.type, id: a.id };
  }

  /**
   * Applies one signed change to a variant. Negative changes require enough stock unless
   * `allowNegative` (used only when undoing an earlier deduction). Returns the new level,
   * or null for variants that do not track stock.
   */
  private async change(
    line: { productId: Types.ObjectId; variantId: Types.ObjectId; delta: number },
    reason: StockReason,
    extra: { reference?: StockMovement['reference']; note?: string; allowNegative?: boolean },
  ): Promise<number | null> {
    const { productId, variantId, delta } = line;
    const match: Record<string, unknown> = { _id: variantId, trackStock: true };
    if (delta < 0 && !extra.allowNegative) match.stock = { $gte: -delta };
    const updated = await this.products.findOneAndUpdate(
      { _id: productId, variants: { $elemMatch: match } },
      { $inc: { 'variants.$.stock': delta } },
      { projection: { variants: 1, name: 1 } },
    );
    if (!updated) {
      const product = await this.products.findById(productId, { variants: 1, name: 1 });
      const variant = product?.variants.find((v) => v._id.equals(variantId));
      // Putting stock back for a product that was deleted since is not an error.
      if (!product || !variant) {
        if (extra.allowNegative) return null;
        throw AppError.notFound('product');
      }
      if (!variant.trackStock) return null;
      throw AppError.conflict(
        'insufficient_stock',
        `Only ${variant.stock} left of ${product.name}${variant.title && variant.title !== 'Default' ? ` (${variant.title})` : ''}.`,
        {
          productId: productId.toHexString(),
          variantId: variantId.toHexString(),
          available: variant.stock,
          requested: -delta,
        },
      );
    }
    const stockAfter = updated.variants.find((v) => v._id.equals(variantId))!.stock;
    await this.movements.create({
      productId,
      variantId,
      delta,
      stockAfter,
      reason,
      ...(extra.reference ? { reference: extra.reference } : {}),
      ...(extra.note ? { note: extra.note } : {}),
      actor: this.actor(),
    });
    return stockAfter;
  }

  /** Takes order quantities out of stock, all or nothing. */
  async deduct(
    lines: StockLine[],
    reason: Extract<StockReason, 'order' | 'order_edit'>,
    reference: StockMovement['reference'],
  ): Promise<void> {
    await this.tx.runOrJoin(async () => {
      for (const line of merge(lines)) {
        await this.change({ ...line, delta: -line.quantity }, reason, { reference });
      }
    });
  }

  /** Puts quantities back (cancelled order, return, edited order). */
  async restore(
    lines: StockLine[],
    reason: Extract<StockReason, 'order_cancel' | 'return' | 'order_edit'>,
    reference: StockMovement['reference'],
  ): Promise<void> {
    await this.tx.runOrJoin(async () => {
      for (const line of merge(lines)) {
        await this.change({ ...line, delta: line.quantity }, reason, {
          reference,
          allowNegative: true,
        });
      }
    });
  }

  /** A manual stock change by staff (count correction, goods received, damage). */
  async adjust(input: {
    productId: string;
    variantId: string;
    mode: 'set' | 'add';
    quantity: number;
    reason: Extract<StockReason, 'adjustment' | 'received' | 'damaged'>;
    note?: string;
  }): Promise<{ stock: number }> {
    const productId = new Types.ObjectId(input.productId);
    const variantId = new Types.ObjectId(input.variantId);
    const result = await this.tx.runOrJoin(async () => {
      const product = await this.products.findById(productId, { variants: 1, name: 1 });
      const variant = product?.variants.find((v) => v._id.equals(variantId));
      if (!product || !variant) throw AppError.notFound('product');
      if (!variant.trackStock)
        throw AppError.unprocessable(
          'stock_not_tracked',
          'This variant does not track stock. Turn on stock tracking first.',
        );
      const delta = input.mode === 'set' ? input.quantity - variant.stock : input.quantity;
      if (delta === 0) return { stock: variant.stock, delta, name: product.name };
      const stock = await this.change({ productId, variantId, delta }, input.reason, {
        note: input.note,
      });
      return { stock: stock!, delta, name: product.name };
    });
    if (result.delta !== 0)
      await this.audit.record({
        action: 'inventory.adjusted',
        orgId: RequestContext.tenant()!.orgId,
        target: { type: 'product', id: input.productId, label: result.name },
        metadata: {
          variantId: input.variantId,
          delta: result.delta,
          stockAfter: result.stock,
          reason: input.reason,
          note: input.note ?? null,
        },
      });
    return { stock: result.stock };
  }

  /** Records the opening stock of a new variant (the product insert already set it). */
  async recordInitial(
    productId: Types.ObjectId,
    variants: { _id: Types.ObjectId; stock: number; trackStock: boolean }[],
  ): Promise<void> {
    const rows = variants
      .filter((v) => v.trackStock && v.stock !== 0)
      .map((v) => ({
        productId,
        variantId: v._id,
        delta: v.stock,
        stockAfter: v.stock,
        reason: 'initial' as const,
        actor: this.actor(),
      }));
    await this.movements.insertMany(rows);
  }

  async history(query: { productId?: string; limit: number; cursor?: string }) {
    const filter = query.productId ? { productId: new Types.ObjectId(query.productId) } : {};
    return this.movements.paginate(filter, query, 'createdAt');
  }
}

/** Combines lines for the same variant so each variant is updated once. */
function merge(lines: StockLine[]) {
  const map = new Map<
    string,
    { productId: Types.ObjectId; variantId: Types.ObjectId; quantity: number }
  >();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.quantity) || l.quantity <= 0)
      throw new Error('Stock quantity must be a positive integer');
    const key = String(l.variantId);
    const prev = map.get(key);
    if (prev) prev.quantity += l.quantity;
    else
      map.set(key, {
        productId: new Types.ObjectId(String(l.productId)),
        variantId: new Types.ObjectId(String(l.variantId)),
        quantity: l.quantity,
      });
  }
  return [...map.values()];
}
