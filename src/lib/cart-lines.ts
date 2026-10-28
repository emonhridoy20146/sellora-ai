/** One line in the shopper's cart. Name, image and price are for display until the cart is priced. */
export interface CartItem {
  productId: string;
  variantId: string;
  quantity: number;
  slug: string;
  name: string;
  variantTitle: string;
  image: string | null;
  priceMinor: number;
}

/** The API prices at most this many lines and this many of each. */
export const MAX_LINES = 30;
export const MAX_QUANTITY = 50;

const clampQuantity = (q: number) => Math.min(MAX_QUANTITY, Math.max(1, Math.floor(q)));

/** A saved cart, cleaned: anything malformed is dropped and quantities kept in range. */
export function parseCart(raw: string | null): CartItem[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (i): i is CartItem =>
          !!i &&
          typeof i === 'object' &&
          typeof (i as CartItem).productId === 'string' &&
          typeof (i as CartItem).variantId === 'string' &&
          Number.isInteger((i as CartItem).quantity),
      )
      .slice(0, MAX_LINES)
      .map((i) => ({ ...i, quantity: clampQuantity(i.quantity) }));
  } catch {
    return [];
  }
}

/** Adds an item: the same variant again adds to its quantity; a new one goes last. */
export function addLine(current: CartItem[], item: CartItem): CartItem[] {
  const found = current.find((i) => i.variantId === item.variantId);
  if (found)
    return current.map((i) =>
      i.variantId === item.variantId
        ? { ...i, ...item, quantity: clampQuantity(i.quantity + item.quantity) }
        : i,
    );
  // A full cart drops its oldest line rather than refusing the newest.
  return [...current, { ...item, quantity: clampQuantity(item.quantity) }].slice(-MAX_LINES);
}

export function setLineQuantity(
  current: CartItem[],
  variantId: string,
  quantity: number,
): CartItem[] {
  const q = clampQuantity(quantity);
  return current.map((i) => (i.variantId === variantId ? { ...i, quantity: q } : i));
}
