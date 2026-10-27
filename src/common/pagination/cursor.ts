import { Types } from 'mongoose';
import { AppError } from '../errors/app-error.js';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Opaque cursor over (sortValue, _id). Encoded as base64url JSON so clients cannot rely on
 * its structure.
 */
export interface CursorPayload {
  v: string | number | null;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (typeof parsed.id !== 'string' || !Types.ObjectId.isValid(parsed.id))
      throw new Error('bad id');
    return parsed;
  } catch {
    throw AppError.badRequest('invalid_cursor', 'The pagination cursor is invalid.');
  }
}

/**
 * Builds a Mongo filter for keyset pagination sorted by `field` descending then _id
 * descending (newest first).
 */
export function keysetFilter(
  field: string,
  cursor: CursorPayload | undefined,
): Record<string, unknown> {
  if (!cursor) return {};
  const id = new Types.ObjectId(cursor.id);
  if (field === '_id') return { _id: { $lt: id } };
  const value =
    cursor.v !== null && typeof cursor.v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(cursor.v)
      ? new Date(cursor.v)
      : cursor.v;
  return { $or: [{ [field]: { $lt: value } }, { [field]: value, _id: { $lt: id } }] };
}

export function buildPage<T extends { _id: Types.ObjectId }>(
  docs: T[],
  limit: number,
  field: string,
): { items: T[]; nextCursor: string | null } {
  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  const last = items.at(-1);
  if (!hasMore || !last) return { items, nextCursor: null };
  const raw = field === '_id' ? null : (last as Record<string, unknown>)[field];
  const v =
    raw instanceof Date ? raw.toISOString() : ((raw as string | number | null | undefined) ?? null);
  return { items, nextCursor: encodeCursor({ v, id: last._id.toHexString() }) };
}
