/** Where this browser keeps a shop's cart and the tokens of saved carts (server-safe). */
export const cartStorageKey = (storeId: string) => `sl_cart_${storeId}`;
export const storeCartTokenKey = (storeId: string) => `sl_cart_token_${storeId}`;
export const landingCartTokenKey = (slug: string) => `sl_lp_token_${slug}`;
