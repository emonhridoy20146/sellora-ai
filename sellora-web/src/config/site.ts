/** Public, non-secret settings. Each can be changed per deployment through env variables. */
export const site = {
  name: process.env.NEXT_PUBLIC_BRAND_NAME ?? 'Sellora AI',
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@sellora.ai',
  description:
    'One inbox for Facebook, Instagram and WhatsApp with an AI sales agent, orders, couriers, fraud checks and your own online store.',
} as const;
