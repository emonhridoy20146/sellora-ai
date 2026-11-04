import type { LedgerType, ModelTier } from '@/lib/api/types';

export const TIER_LABEL: Record<ModelTier, { name: string; use: string }> = {
  fast: { name: 'Fast', use: 'Quick replies and simple answers' },
  standard: { name: 'Standard', use: 'Most sales conversations and product text' },
  advanced: { name: 'Advanced', use: 'Hard questions, long chats, SEO research' },
};

export const LEDGER_LABEL: Record<LedgerType, string> = {
  topup: 'Top-up',
  bonus: 'Free credit',
  ai_usage: 'AI usage',
  sms_usage: 'SMS',
  subscription: 'Plan',
  refund: 'Refund',
  adjustment: 'Adjustment',
  withdrawal: 'Withdrawal',
};

export const GATEWAY_LABEL: Record<string, string> = {
  sslcommerz: 'Card, bank or mobile wallet (SSLCommerz)',
  bkash: 'bKash',
  stripe: 'International card (Stripe)',
  manual: 'Bank or mobile transfer',
};

export const METHOD_LABEL: Record<string, string> = {
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  bank: 'Bank transfer',
  cash: 'Cash',
  original_method: 'Back to how I paid',
};

export const INTERVAL_LABEL: Record<string, string> = {
  month: 'Monthly',
  year: 'Yearly',
  lifetime: 'Lifetime',
  trial: 'Free trial',
  free: 'Free',
};
