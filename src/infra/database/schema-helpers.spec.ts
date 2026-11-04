import type { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { aiAgentSettingsSchema } from '../../modules/ai/agent-settings.schema.js';
import { subscriptionSchema, walletSchema } from '../../modules/billing/schemas.js';
import { cartSettingsSchema } from '../../modules/carts/schemas.js';
import { shopSettingsSchema } from '../../modules/commerce/schemas.js';
import { storageUsageSchema } from '../../modules/files/schemas.js';
import { fraudSettingsSchema } from '../../modules/fraud/schemas.js';
import { smsSettingsSchema } from '../../modules/sms/schemas.js';

/** Documents a business has exactly one of. */
const ONE_PER_BUSINESS: Record<string, Schema> = {
  aiAgentSettings: aiAgentSettingsSchema as Schema,
  subscription: subscriptionSchema as Schema,
  wallet: walletSchema as Schema,
  cartSettings: cartSettingsSchema as Schema,
  shopSettings: shopSettingsSchema as Schema,
  storageUsage: storageUsageSchema as Schema,
  fraudSettings: fraudSettingsSchema as Schema,
  smsSettings: smsSettingsSchema as Schema,
};

describe('one document per business', () => {
  it.each(Object.entries(ONE_PER_BUSINESS))(
    '%s has a single, unique orgId index',
    (_name, schema) => {
      const onOrg = schema
        .indexes()
        .filter(([key]) => JSON.stringify(key) === JSON.stringify({ orgId: 1 }));
      // Two definitions with the same key leave MongoDB to build whichever comes first.
      expect(onOrg).toHaveLength(1);
      expect(onOrg[0]![1]).toMatchObject({ unique: true });
    },
  );
});
