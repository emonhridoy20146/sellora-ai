import type { CatalogConnector, SourceKind } from './connector.js';
import { CsvConnector, SheetConnector } from './sheet.connector.js';
import { ShopifyConnector } from './shopify.connector.js';
import { WebsiteConnector } from './website.connector.js';
import { WooCommerceConnector } from './woocommerce.connector.js';

/** Every catalog source kind and the code that reads it (ADR 0023). */
export const CONNECTORS: Record<SourceKind, CatalogConnector> = {
  shopify: new ShopifyConnector(),
  woocommerce: new WooCommerceConnector(),
  sheet: new SheetConnector(),
  csv: new CsvConnector(),
  website: new WebsiteConnector(),
};
