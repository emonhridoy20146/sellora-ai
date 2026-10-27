/**
 * What the public site says the product does. `live` means a merchant can use it today;
 * everything else is labelled "Coming soon" on the site. Flip a flag only when the feature
 * works end to end (see docs/TRACKER.md in sellora-api), never because a screen exists.
 */
export type FeatureStatus = 'live' | 'soon';

export interface MarketingFeature {
  key: string;
  title: string;
  body: string;
  status: FeatureStatus;
}

export const FEATURES: MarketingFeature[] = [
  {
    key: 'inbox',
    title: 'One inbox for every chat',
    body: 'Messenger, Instagram, WhatsApp and your website chat in one place, shared by your whole team.',
    status: 'soon',
  },
  {
    key: 'ai_agent',
    title: 'AI that sells like your best staff',
    body: 'Answers price, size and delivery questions in Bangla, English or Banglish, suggests products and takes the order.',
    status: 'soon',
  },
  {
    key: 'commerce',
    title: 'Orders, products and stock',
    body: 'Enter an order in seconds, track stock for every size and colour, and print invoices and packing slips for the courier. Turning a chat into an order arrives with the inbox.',
    status: 'live',
  },
  {
    key: 'couriers',
    title: 'Courier booking and fraud check',
    body: "Book Steadfast, Pathao and more, and see a customer's delivery success rate before you ship.",
    status: 'soon',
  },
  {
    key: 'storefront',
    title: 'Your own online store',
    body: 'A fast store on your own web address, plus landing pages built to sell one product.',
    status: 'soon',
  },
  {
    key: 'team',
    title: 'Staff roles and two-step sign-in',
    body: 'Give each person only the access they need. Every important action is recorded.',
    status: 'live',
  },
  {
    key: 'wallet',
    title: 'Pay only for the AI you use',
    body: 'Top up with bKash, Nagad, bank or card. See every credit spent, per conversation.',
    status: 'live',
  },
  {
    key: 'growth',
    title: 'Ads, SEO and follow-ups',
    body: 'Ads reports with forecasts, AI SEO writing, and automatic follow-ups that win back carts.',
    status: 'soon',
  },
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'What is an AI credit?',
    a: 'A unit of AI work. Short replies use a fraction of a credit, long ones more. You see the price of a credit and every charge in your wallet, so there are no surprises.',
  },
  {
    q: 'Do I need a card?',
    a: 'No. You can pay with bKash, Nagad, Rocket or a bank transfer. International cards work too where the gateway is enabled.',
  },
  {
    q: 'Can my staff use it?',
    a: 'Yes. Invite them, pick a role, and they only see what that role allows. You can remove access at any time.',
  },
  {
    q: 'Is my data safe?',
    a: "Each business's data is kept separate, sign-in supports two-step verification, and every sensitive action goes to an audit log you can read.",
  },
];

/**
 * Plan modules a merchant can use today (keys from GET /platform/billing/modules). Others
 * are listed on pricing cards as "coming soon". Add a key when its milestone ships.
 */
export const LIVE_MODULES: readonly string[] = ['commerce'];
