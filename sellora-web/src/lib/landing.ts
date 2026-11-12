import type {
  AbTest,
  AbTestSettings,
  LandingContent,
  LandingLanguage,
  LandingPageSummary,
  LandingPackage,
  LandingSection,
  LandingSectionType,
  LandingStatus,
  Product,
} from './api/types';
import { formatDateTime, humanize } from './format';
import { newSectionId } from './stores';

/**
 * Landing page rules the editor needs before it talks to the API (ADR 0016). The API checks
 * all of them again; these only let the editor say what is wrong next to the field.
 */

export const MAX_LANDING_SECTIONS = 30;
export const MAX_PACKAGES = 6;

export const LANDING_STATUS: Record<
  LandingStatus,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; text: string }
> = {
  draft: {
    label: 'Draft',
    tone: 'neutral',
    text: 'Only you can see it. Publish it when it is ready.',
  },
  in_review: {
    label: 'In review',
    tone: 'warning',
    text: 'Sellora is checking this version. You get an email when it goes live.',
  },
  changes_requested: {
    label: 'Changes needed',
    tone: 'danger',
    text: 'The review asked for changes. Fix them and publish again.',
  },
  scheduled: {
    label: 'Scheduled',
    tone: 'info',
    text: 'Approved, and goes live by itself at the time you chose.',
  },
  live: { label: 'Live', tone: 'success', text: 'Shoppers can see the page and order.' },
  paused: {
    label: 'Paused',
    tone: 'neutral',
    text: 'Shoppers see that the offer is not available right now.',
  },
  taken_down: {
    label: 'Taken down',
    tone: 'danger',
    text: 'Sellora took this page down. Fix it and publish again for review.',
  },
};

// ---------------------------------------------------------------- addresses

/** Paths of the storefront itself; kept in step with the API's RESERVED_SLUGS. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'cart',
  'checkout',
  'order',
  'orders',
  'track',
  'products',
  'product',
  'pages',
  'page',
  'preview',
  'search',
  'category',
  'categories',
  'collections',
  'blog',
  'account',
  'login',
  'signup',
  'admin',
  'sitemap',
  'robots',
  'static',
  'assets',
  'images',
  'thank-you',
  'favicon',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

/** Why a page address cannot be used, in words, or null. */
export function slugProblem(slug: string): string | null {
  if (!SLUG_RE.test(slug) || slug.includes('--'))
    return 'Use 3 to 60 lower-case letters, numbers and single hyphens';
  if (RESERVED_SLUGS.has(slug)) return 'This address is used by the store itself; choose another';
  return null;
}

/** A page address from a name: Latin letters and digits joined by hyphens. */
export function toSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

// ---------------------------------------------------------------- sections

export const LANDING_SECTION_LABEL: Record<LandingSectionType, string> = {
  hero: 'Top offer',
  image: 'Picture',
  gallery: 'Pictures',
  video: 'Video',
  benefits: 'Benefits',
  problem_solution: 'Problem and solution',
  specs: 'Details table',
  steps: 'How to use',
  before_after: 'Before and after',
  reviews: 'Reviews',
  countdown: 'Countdown',
  stock_left: 'Stock left',
  price: 'Price box',
  faq: 'Questions',
  guarantee: 'Guarantees',
  delivery: 'Delivery',
  contact: 'Call and WhatsApp',
  text: 'Text',
  order_form: 'Order form',
  announcement: 'Announcement bar',
  video_hero: 'Top video',
  features: 'Features with icons',
  checklist: 'Checklist',
  comparison: 'Comparison table',
  ingredients: 'Ingredients',
  timeline: 'Timeline',
  who_for: 'Who it is for',
  stats: 'Numbers',
  orders_today: 'Orders today',
  video_reviews: 'Video reviews',
  quote: 'Quote',
  certificates: 'Certificates',
  image_text: 'Picture and text',
  about: 'About us',
  size_chart: 'Size chart',
  packages: 'Package cards',
  payment_methods: 'Payment methods',
  coupon_banner: 'Coupon code',
  call_to_action: 'Order button band',
  location: 'Shop address',
  spacer: 'Space',
};

export const LANDING_SECTION_HINT: Record<LandingSectionType, string> = {
  hero: 'The big headline, offer badge and order button.',
  image: 'One picture with a caption.',
  gallery: 'The product’s pictures, or your own.',
  video: 'A YouTube or Facebook video.',
  benefits: 'Short reasons to buy.',
  problem_solution: 'The buyer’s problem and how the product solves it.',
  specs: 'Size, weight, materials and other facts.',
  steps: 'Numbered steps.',
  before_after: 'Two pictures side by side.',
  reviews: 'What buyers said, with screenshots.',
  countdown: 'A timer until the offer ends.',
  stock_left: 'Shows the real stock when it runs low.',
  price: 'The price with the saving.',
  faq: 'Questions and answers.',
  guarantee: 'Cash on delivery, returns and other promises.',
  delivery: 'Your delivery areas and charges.',
  contact: 'Buttons to call or message you.',
  text: 'A heading and paragraphs.',
  order_form: 'Where shoppers order. A page has exactly one.',
  announcement: 'A short coloured line, like today’s offer.',
  video_hero: 'Your product video with the headline and order button.',
  features: 'Features with small icons.',
  checklist: 'Ticked points: reasons to buy or what is in the set.',
  comparison: 'Yours against others, row by row.',
  ingredients: 'What it is made of, with pictures.',
  timeline: 'What happens week by week, or a schedule.',
  who_for: 'Who should buy it, and who should not.',
  stats: 'A few real numbers, like customers served.',
  orders_today: 'The real number of orders this page took today.',
  video_reviews: 'Buyers’ videos from YouTube or Facebook.',
  quote: 'Words from an expert or the founder.',
  certificates: 'Pictures of approvals and certificates.',
  image_text: 'A picture beside a paragraph.',
  about: 'Your story.',
  size_chart: 'Sizes and measurements in a table.',
  packages: 'The offer’s packages as cards; a tap fills in the order form.',
  payment_methods: 'How shoppers can pay, from your payment settings.',
  coupon_banner: 'A coupon code shoppers can use on this page.',
  call_to_action: 'A heading with a button to the order form.',
  location: 'Your shop’s address, hours and a map link.',
  spacer: 'Empty space between sections.',
};

/** How the "Add section" menu groups the section kinds. */
export const LANDING_SECTION_GROUPS: { label: string; types: LandingSectionType[] }[] = [
  {
    label: 'Top of the page',
    types: ['hero', 'video_hero', 'announcement', 'countdown', 'call_to_action'],
  },
  {
    label: 'Pictures and video',
    types: ['image', 'gallery', 'video', 'before_after', 'image_text'],
  },
  {
    label: 'About the product',
    types: [
      'benefits',
      'features',
      'checklist',
      'problem_solution',
      'ingredients',
      'specs',
      'size_chart',
      'steps',
      'timeline',
      'comparison',
      'who_for',
      'text',
    ],
  },
  {
    label: 'Trust',
    types: [
      'reviews',
      'video_reviews',
      'quote',
      'stats',
      'certificates',
      'guarantee',
      'about',
      'orders_today',
      'stock_left',
    ],
  },
  {
    label: 'Buying',
    types: [
      'order_form',
      'price',
      'packages',
      'coupon_banner',
      'payment_methods',
      'delivery',
      'faq',
      'contact',
      'location',
      'spacer',
    ],
  },
];

/** The order the "Add section" menu lists them in. */
export const LANDING_SECTION_TYPES = Object.keys(LANDING_SECTION_LABEL) as LandingSectionType[];

export const HIDE_ON_LABEL = {
  none: 'Phones and computers',
  mobile: 'Computers only',
  desktop: 'Phones only',
} as const;

const NEW_TEXT: Record<
  LandingLanguage,
  {
    order: string;
    benefits: string;
    specs: string;
    steps: string;
    reviews: string;
    countdown: string;
    ended: string;
    stock: string;
    price: string;
    priceNote: string;
    faq: string;
    guarantee: string;
    delivery: string;
    deliveryText: string;
    contact: string;
    contactText: string;
    formHeading: string;
    formSub: string;
    confirm: string;
    problem: string;
    solution: string;
    beforeAfter: string;
    gallery: string;
  }
> = {
  en: {
    order: 'Order now',
    benefits: 'Why people choose it',
    specs: 'Details',
    steps: 'How to use',
    reviews: 'What buyers say',
    countdown: 'Offer ends in',
    ended: 'This offer has ended.',
    stock: 'Only {count} left in stock',
    price: 'Offer price',
    priceNote: 'Delivery charge is added at checkout.',
    faq: 'Questions',
    guarantee: 'Order without worry',
    delivery: 'Delivery',
    deliveryText: 'We deliver across Bangladesh. Pay cash when the parcel reaches you.',
    contact: 'Questions? Talk to us',
    contactText: 'Call or message us and we will help you choose.',
    formHeading: 'Order now',
    formSub: 'Write your name, phone number and address. We call to confirm before sending.',
    confirm: 'Confirm order',
    problem: 'Tired of this problem?',
    solution: 'Here is the solution',
    beforeAfter: 'Before and after',
    gallery: 'Pictures',
  },
  bn: {
    order: 'এখনই অর্ডার করুন',
    benefits: 'কেন সবাই এটি বেছে নেয়',
    specs: 'বিস্তারিত',
    steps: 'ব্যবহারের নিয়ম',
    reviews: 'ক্রেতারা যা বলছেন',
    countdown: 'অফার শেষ হতে বাকি',
    ended: 'এই অফারটি শেষ হয়েছে।',
    stock: 'স্টকে আর মাত্র {count}টি আছে',
    price: 'অফার মূল্য',
    priceNote: 'ডেলিভারি চার্জ অর্ডারের সময় যোগ হবে।',
    faq: 'প্রশ্ন ও উত্তর',
    guarantee: 'নিশ্চিন্তে অর্ডার করুন',
    delivery: 'ডেলিভারি',
    deliveryText: 'সারা বাংলাদেশে ডেলিভারি। পণ্য হাতে পেয়ে টাকা দিন।',
    contact: 'প্রশ্ন আছে? কথা বলুন',
    contactText: 'কল বা মেসেজ করুন, আমরা সাহায্য করব।',
    formHeading: 'এখনই অর্ডার করুন',
    formSub: 'আপনার নাম, ফোন নম্বর ও ঠিকানা লিখুন। পাঠানোর আগে আমরা কল করে নিশ্চিত করব।',
    confirm: 'অর্ডার নিশ্চিত করুন',
    problem: 'এই সমস্যায় ভুগছেন?',
    solution: 'এর সমাধান',
    beforeAfter: 'আগে ও পরে',
    gallery: 'ছবি',
  },
};

const MORE_TEXT: Record<
  LandingLanguage,
  {
    features: string;
    checklist: string;
    comparison: string;
    ours: string;
    others: string;
    ingredients: string;
    timeline: string;
    whoFor: string;
    forTitle: string;
    notForTitle: string;
    ordersToday: string;
    about: string;
    sizes: string;
    size: string;
    packages: string;
    payments: string;
    coupon: string;
    location: string;
  }
> = {
  en: {
    features: 'Features',
    checklist: 'Why buy it',
    comparison: 'Compared',
    ours: 'Ours',
    others: 'Others',
    ingredients: 'What is inside',
    timeline: 'What to expect',
    whoFor: 'Is it right for you?',
    forTitle: 'Made for',
    notForTitle: 'Not for',
    ordersToday: '{count} people ordered from this page today',
    about: 'About us',
    sizes: 'Size chart',
    size: 'Size',
    packages: 'Choose your package',
    payments: 'Pay the way you like',
    coupon: 'Use this code for a discount',
    location: 'Where to find us',
  },
  bn: {
    features: 'ফিচারসমূহ',
    checklist: 'কেন কিনবেন',
    comparison: 'তুলনা',
    ours: 'আমাদের',
    others: 'অন্যদের',
    ingredients: 'ভেতরে যা আছে',
    timeline: 'কী আশা করবেন',
    whoFor: 'এটি কি আপনার জন্য?',
    forTitle: 'যাদের জন্য',
    notForTitle: 'যাদের জন্য নয়',
    ordersToday: 'আজ এই পেজ থেকে {count} জন অর্ডার করেছেন',
    about: 'আমাদের কথা',
    sizes: 'সাইজ চার্ট',
    size: 'সাইজ',
    packages: 'আপনার প্যাকেজ বেছে নিন',
    payments: 'যেভাবে খুশি টাকা দিন',
    coupon: 'ছাড় পেতে এই কোডটি ব্যবহার করুন',
    location: 'আমাদের ঠিকানা',
  },
};

/** Three days from now at the next full hour, as a starting end time for a countdown. */
function inThreeDays(now = Date.now()): string {
  const d = new Date(now + 3 * 86_400_000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

/** A new section with starting text in the page's language. */
export function newLandingSection(
  type: LandingSectionType,
  language: LandingLanguage,
  id = newSectionId(),
  now = Date.now(),
): LandingSection {
  const t = NEW_TEXT[language];
  const m = MORE_TEXT[language];
  const base = { id, enabled: true, hideOn: 'none' as const };
  switch (type) {
    case 'hero':
      return {
        ...base,
        type,
        heading: '',
        subheading: '',
        badge: '',
        buttonLabel: t.order,
        image: null,
        showPrice: true,
      };
    case 'image':
      return { ...base, type, image: null, caption: '' };
    case 'gallery':
      return { ...base, type, title: t.gallery, source: 'product', images: [] };
    case 'video':
      return { ...base, type, title: '', url: '' };
    case 'benefits':
      return { ...base, type, title: t.benefits, items: [{ title: '', text: '' }] };
    case 'problem_solution':
      return {
        ...base,
        type,
        problemTitle: t.problem,
        problem: '',
        solutionTitle: t.solution,
        solution: '',
        image: null,
      };
    case 'specs':
      return { ...base, type, title: t.specs, rows: [{ label: '', value: '' }] };
    case 'steps':
      return { ...base, type, title: t.steps, steps: [{ text: '' }] };
    case 'before_after':
      return { ...base, type, title: t.beforeAfter, before: null, after: null, caption: '' };
    case 'reviews':
      return { ...base, type, title: t.reviews, items: [] };
    case 'countdown':
      return { ...base, type, heading: t.countdown, endsAt: inThreeDays(now), endedText: t.ended };
    case 'stock_left':
      return { ...base, type, text: t.stock, threshold: 10 };
    case 'price':
      return { ...base, type, heading: t.price, note: t.priceNote };
    case 'faq':
      return { ...base, type, title: t.faq, items: [{ question: '', answer: '' }] };
    case 'guarantee':
      return { ...base, type, title: t.guarantee, items: [] };
    case 'delivery':
      return { ...base, type, heading: t.delivery, text: t.deliveryText, showAreas: true };
    case 'contact':
      return {
        ...base,
        type,
        heading: t.contact,
        text: t.contactText,
        call: true,
        whatsapp: true,
      };
    case 'text':
      return { ...base, type, heading: '', body: '' };
    case 'order_form':
      return {
        ...base,
        type,
        heading: t.formHeading,
        subheading: t.formSub,
        buttonLabel: t.confirm,
      };
    case 'announcement':
      return { ...base, type, text: '', tone: 'offer' };
    case 'video_hero':
      return { ...base, type, heading: '', subheading: '', url: '', buttonLabel: t.order };
    case 'features':
      return { ...base, type, title: m.features, items: [{ icon: 'shield', title: '', text: '' }] };
    case 'checklist':
      return { ...base, type, title: m.checklist, items: [''] };
    case 'comparison':
      return {
        ...base,
        type,
        title: m.comparison,
        ourLabel: m.ours,
        otherLabel: m.others,
        rows: [{ label: '', ours: '✓', others: '✗' }],
      };
    case 'ingredients':
      return { ...base, type, title: m.ingredients, items: [{ name: '', text: '', image: null }] };
    case 'timeline':
      return { ...base, type, title: m.timeline, items: [{ label: '', text: '' }] };
    case 'who_for':
      return {
        ...base,
        type,
        title: m.whoFor,
        forTitle: m.forTitle,
        forItems: [''],
        notForTitle: m.notForTitle,
        notForItems: [],
      };
    case 'stats':
      return { ...base, type, title: '', items: [{ value: '', label: '' }] };
    case 'orders_today':
      return { ...base, type, text: m.ordersToday, minCount: 5 };
    case 'video_reviews':
      return { ...base, type, title: t.reviews, items: [{ url: '', name: '' }] };
    case 'quote':
      return { ...base, type, text: '', name: '', role: '', image: null };
    case 'certificates':
      return { ...base, type, title: '', items: [] };
    case 'image_text':
      return { ...base, type, heading: '', body: '', image: null, imageSide: 'left' };
    case 'about':
      return { ...base, type, heading: m.about, body: '', image: null };
    case 'size_chart':
      return {
        ...base,
        type,
        title: m.sizes,
        columns: [m.size, ''],
        rows: [{ cells: ['', ''] }],
        note: '',
      };
    case 'packages':
      return { ...base, type, heading: m.packages, text: '' };
    case 'payment_methods':
      return { ...base, type, heading: m.payments, text: '' };
    case 'coupon_banner':
      return { ...base, type, heading: m.coupon, code: '', text: '' };
    case 'call_to_action':
      return { ...base, type, heading: t.formHeading, text: '', buttonLabel: t.order };
    case 'location':
      return { ...base, type, heading: m.location, address: '', hours: '', mapUrl: '' };
    case 'spacer':
      return { ...base, type, size: 'medium', line: false };
  }
}

/** The line shown for a section in the list: its own heading or title when it has one. */
export function landingSectionSummary(s: LandingSection): string {
  const label = LANDING_SECTION_LABEL[s.type];
  switch (s.type) {
    case 'hero':
    case 'countdown':
    case 'price':
    case 'delivery':
    case 'contact':
    case 'text':
    case 'order_form':
      return s.heading || label;
    case 'gallery':
    case 'video':
    case 'benefits':
    case 'specs':
    case 'steps':
    case 'before_after':
    case 'reviews':
    case 'faq':
    case 'guarantee':
      return s.title || label;
    case 'image':
      return s.caption || label;
    case 'problem_solution':
      return s.problemTitle || label;
    case 'stock_left':
    case 'announcement':
      return s.text || label;
    case 'video_hero':
    case 'image_text':
    case 'about':
    case 'packages':
    case 'payment_methods':
    case 'call_to_action':
    case 'location':
      return s.heading || label;
    case 'coupon_banner':
      return s.code ? `${label}: ${s.code}` : label;
    case 'features':
    case 'checklist':
    case 'comparison':
    case 'ingredients':
    case 'timeline':
    case 'who_for':
    case 'stats':
    case 'video_reviews':
    case 'certificates':
    case 'size_chart':
      return s.title || label;
    case 'quote':
      return s.name ? `${label}: ${s.name}` : label;
    case 'orders_today':
    case 'spacer':
      return label;
  }
}

/** A Google Maps link (the only map a page links to; never embedded). */
export function isMapLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl' || host === 'maps.google.com') return true;
  if (host === 'goo.gl') return url.pathname.startsWith('/maps');
  return (host === 'www.google.com' || host === 'google.com') && url.pathname.startsWith('/maps');
}

/** A coupon code as the API keeps it: capitals, no spaces. */
export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** Why a coupon code cannot be used, or null. */
export function couponCodeProblem(code: string): string | null {
  return /^[A-Z0-9][A-Z0-9-]{2,19}$/.test(code) && !code.includes('--') && !code.endsWith('-')
    ? null
    : 'Use 3 to 20 letters, numbers and single hyphens.';
}

/** A YouTube or Facebook video link (the only players a page embeds). */
export function isVideoLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const yt = /^[A-Za-z0-9_-]{11}$/;
  if (host === 'youtu.be') return yt.test(url.pathname.slice(1).split('/')[0] ?? '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const id =
      url.searchParams.get('v') ??
      (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '') ? (parts[1] ?? '') : '');
    return yt.test(id);
  }
  if (host === 'fb.watch') return true;
  if (host === 'facebook.com') {
    const path = url.pathname.replace(/\/+$/, '');
    return (
      /\/videos\/\d+/.test(path) ||
      /^\/reel\/\d+/.test(path) ||
      (path === '/watch' && /^\d+$/.test(url.searchParams.get('v') ?? ''))
    );
  }
  return false;
}

/** No template words to look for (before the list has loaded). */
const NO_STARTER: ReadonlySet<string> = new Set();

/**
 * What a shown section still needs before the page can be published; null when it is fine.
 * Hidden sections never block publishing. `starter` is the API's list of template words that
 * are instructions or sample reviews, which cannot go live as they are.
 */
export function landingSectionProblem(
  s: LandingSection,
  starter: ReadonlySet<string> = NO_STARTER,
): string | null {
  if (!s.enabled) return null;
  const isStarter = (text: string) => starter.has(text.trim());
  switch (s.type) {
    case 'video':
      if (!s.url.trim()) return 'Add the video link.';
      return isVideoLink(s.url) ? null : 'Use a YouTube or Facebook video link.';
    case 'countdown':
      return s.endsAt ? null : 'Set when the offer ends.';
    case 'image':
      return s.image ? null : 'Add the picture.';
    case 'gallery':
      return s.source === 'custom' && s.images.length === 0 ? 'Add at least one picture.' : null;
    case 'before_after':
      return s.before && s.after ? null : 'Add both the before and the after picture.';
    case 'reviews':
      if (s.items.some((r) => !r.text.trim() && !r.image))
        return 'Every review needs words or a screenshot.';
      return s.items.some((r) => isStarter(r.name) || isStarter(r.text))
        ? 'Replace the sample reviews with real ones from your buyers, or hide this section.'
        : null;
    case 'video_hero':
      if (!s.url.trim()) return 'Add the video link.';
      if (!isVideoLink(s.url)) return 'Use a YouTube or Facebook video link.';
      if (!s.heading.trim()) return 'Write the headline.';
      break;
    case 'video_reviews':
      if (s.items.length === 0) return 'Add at least one video.';
      if (s.items.some((x) => !x.url.trim() || !isVideoLink(x.url)))
        return 'Every video needs a YouTube or Facebook link.';
      break;
    case 'announcement':
      if (!s.text.trim()) return 'Write the announcement.';
      break;
    case 'features':
    case 'ingredients':
    case 'timeline':
    case 'stats':
      if (s.items.length === 0) return 'Add at least one item.';
      break;
    case 'checklist':
      if (!s.items.some((x) => x.trim())) return 'Add at least one item.';
      break;
    case 'certificates':
      if (s.items.length === 0) return 'Add at least one picture.';
      break;
    case 'comparison':
      if (s.rows.length === 0) return 'Add at least one row.';
      break;
    case 'who_for':
      if (!s.forItems.some((x) => x.trim())) return 'Say who the product is for.';
      break;
    case 'orders_today':
      if (!s.text.includes('{count}')) return 'Put {count} where the number goes.';
      break;
    case 'quote':
      if (!s.text.trim()) return 'Write the quote.';
      break;
    case 'image_text':
      if (!s.image) return 'Add the picture.';
      break;
    case 'size_chart':
      if (s.columns.length < 2) return 'Add at least two columns.';
      if (s.rows.length === 0) return 'Add at least one row.';
      if (s.rows.some((r) => r.cells.length !== s.columns.length))
        return 'Fill every row for every column.';
      break;
    case 'coupon_banner':
      if (!s.code.trim()) return 'Write the coupon code.';
      if (couponCodeProblem(normalizeCouponCode(s.code))) return couponCodeProblem(s.code);
      break;
    case 'location':
      if (!s.address.trim()) return 'Write the address.';
      if (s.mapUrl.trim() && !isMapLink(s.mapUrl)) return 'Use a Google Maps link.';
      break;
    default:
      break;
  }
  // Any shown section that still has a template's instruction cannot go live.
  return sectionWords(s).some((w) => isStarter(w.text))
    ? 'Replace the template’s sample words with your own, or hide this section.'
    : null;
}

/** Everything that stops the draft from being published, as sentences. */
export function publishBlockers(
  content: LandingContent,
  starter: ReadonlySet<string> = NO_STARTER,
): string[] {
  const out: string[] = [];
  const forms = content.sections.filter((s) => s.type === 'order_form' && s.enabled).length;
  if (forms !== 1) out.push('Show one order form on the page.');
  if (!content.offer.productId) out.push('Choose the product this page sells.');
  if (content.offer.addOn && content.offer.addOn.productId === content.offer.productId)
    out.push('Choose a different product for the add-on.');
  if (
    content.offer.packages.length === 0 &&
    content.sections.some((s) => s.type === 'packages' && s.enabled)
  )
    out.push(`${LANDING_SECTION_LABEL.packages}: Add packages to the offer, or hide this section.`);
  for (const s of content.sections) {
    const p = landingSectionProblem(s, starter);
    if (p) out.push(`${LANDING_SECTION_LABEL[s.type]}: ${p}`);
  }
  return out;
}

// ---------------------------------------------------------------- packages and prices

/** The lowest price among the product's options. */
export function lowestPrice(product: Pick<Product, 'variants'>): number {
  return Math.min(...product.variants.map((v) => v.priceMinor));
}

/** What a package costs and what it saves against the regular price of `unitMinor`. */
export function packagePrice(
  pkg: Pick<LandingPackage, 'quantity' | 'priceMinor'>,
  unitMinor: number,
): { totalMinor: number; regularMinor: number; savingMinor: number } {
  const regularMinor = unitMinor * pkg.quantity;
  const totalMinor = pkg.priceMinor ?? regularMinor;
  return { totalMinor, regularMinor, savingMinor: Math.max(0, regularMinor - totalMinor) };
}

/** A new package: one more than the last, at the regular price. */
export function newPackage(existing: LandingPackage[], language: LandingLanguage): LandingPackage {
  const quantity = Math.min(20, (existing.at(-1)?.quantity ?? 0) + 1);
  return {
    id: newSectionId(),
    label:
      language === 'bn' ? `${quantity}টি` : `${quantity} ${quantity === 1 ? 'piece' : 'pieces'}`,
    quantity,
    priceMinor: null,
    badge: '',
  };
}

/** Problems with the packages, by package id. */
export function packageProblems(
  packages: LandingPackage[],
  unitMinor: number | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of packages) {
    if (!p.label.trim()) out[p.id] = 'Name the package.';
    else if (p.priceMinor !== null && p.priceMinor < 1)
      out[p.id] = 'Set a price, or leave it empty.';
    else if (p.priceMinor !== null && unitMinor !== null && p.priceMinor > unitMinor * p.quantity)
      out[p.id] = 'This costs more than buying the pieces one by one.';
  }
  return out;
}

/** Conversion as people read it: "3.2%". */
export function conversionText(rate: number | null): string {
  if (rate === null) return '–';
  const pct = rate * 100;
  return `${pct >= 10 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** Keys that hold settings or ids rather than words a shopper reads. */
const NOT_WORDS = new Set(['id', 'type', 'enabled', 'hideOn', 'fileId', 'source', 'icon']);

/**
 * Every word a section shows, as label/value lines: what a reviewer has to read for
 * misleading claims. Pictures show as their descriptions; video links are included.
 */
export function sectionWords(section: LandingSection): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  const walk = (value: unknown, path: string, key: string) => {
    if (typeof value === 'string') {
      if (value.trim())
        out.push({ key: path, text: key === 'endsAt' ? formatDateTime(value) : value });
    } else if (typeof value === 'number' && key === 'rating') {
      out.push({ key: path, text: `${value} of 5` });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path} ${i + 1}`, key));
    } else if (value && typeof value === 'object' && 'fileId' in value) {
      // A picture: the preview shows it; the words are its description.
      const alt = (value as { alt?: string }).alt?.trim();
      out.push({ key: path, text: alt ? `Picture: ${alt}` : 'Picture (no description)' });
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (NOT_WORDS.has(k)) continue;
        walk(v, path ? `${path} · ${humanize(k)}` : humanize(k), k);
      }
    }
  };
  walk(section, '', '');
  return out;
}

// ---------------------------------------------------------------- publishing (ADR 0031)

/** The API's A/B test settings when none are chosen. */
export const AB_DEFAULTS: AbTestSettings = {
  splitB: 50,
  autoWinner: true,
  minVisitors: 300,
  maxDays: 14,
};

/** How far ahead a version may be scheduled. */
export const SCHEDULE_MAX_DAYS = 90;

/** Why the page cannot start an A/B test now, or null (the API checks the same). */
export function abTestBlocker(
  page: Pick<LandingPageSummary, 'published' | 'paused' | 'takedown' | 'abTest' | 'scheduled'>,
): string | null {
  if (!page.published || page.paused || page.takedown)
    return 'A test compares a new version with the live one, so the page must be live first.';
  if (page.abTest) return 'A test is already running on this page.';
  if (page.scheduled) return 'A version is scheduled. Publish it now or cancel it before testing.';
  return null;
}

/** Why a publishing time cannot be used, or null. */
export function publishAtProblem(iso: string | null, now = Date.now()): string | null {
  if (!iso) return 'Choose a date and time.';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Choose a date and time.';
  if (t <= now + 60_000) return 'Choose a time at least a minute from now.';
  if (t > now + SCHEDULE_MAX_DAYS * 86_400_000)
    return `Choose a time within ${SCHEDULE_MAX_DAYS} days.`;
  return null;
}

/** Why an offer end time cannot be used, or null. */
export function offerEndProblem(iso: string | null, now = Date.now()): string | null {
  if (!iso) return 'Choose a date and time.';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Choose a date and time.';
  if (t <= now + 60_000) return 'Choose a time at least a minute from now.';
  if (t > now + 366 * 86_400_000) return 'Choose a time within a year.';
  return null;
}

/** Why an A/B test ended, for the dashboard. */
export const AB_END_REASON: Record<NonNullable<AbTest['endReason']>, string> = {
  chosen: 'You chose',
  auto_winner: 'Clear winner, chosen by itself',
  no_clear_winner: 'Time was up without a clear winner',
  taken_down: 'Sellora took the page down',
};

/** "12.5%" for a buying rate (0..1), or a dash. */
export function formatRate(rate: number | null): string {
  if (rate === null) return '–';
  return `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%`;
}

/** "+18%" or "−7%" for B against A, or a dash. */
export function formatLift(lift: number | null): string {
  if (lift === null || !Number.isFinite(lift)) return '–';
  const pct = Math.round(lift * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${Math.abs(pct)}%` : '0%';
}

/** What a running test's numbers say so far, in plain words. */
export function abVerdict(test: Pick<AbTest, 'counts' | 'result' | 'settings'>): {
  tone: 'success' | 'info' | 'warning';
  title: string;
  text: string;
} {
  const { result: r, counts, settings } = test;
  const sure = r.confidence === null ? null : Math.floor(r.confidence * 100);
  if (r.leader)
    return {
      tone: 'success',
      title:
        r.leader === 'b' ? 'The new version (B) sells better' : 'The live version (A) sells better',
      text: `Buying rate ${formatRate(r.rateA)} for A and ${formatRate(r.rateB)} for B (B against A: ${formatLift(r.lift)}), ${sure}% sure.`,
    };
  if (!r.enoughVisitors) {
    const need = settings.minVisitors;
    return {
      tone: 'info',
      title: 'Too early to tell',
      text: `Each version needs ${need.toLocaleString('en-US')} visitors before a winner is called. So far A had ${counts.a.visitors.toLocaleString('en-US')} and B ${counts.b.visitors.toLocaleString('en-US')}.`,
    };
  }
  return {
    tone: 'warning',
    title: 'No clear winner yet',
    text:
      sure === null
        ? 'Neither version has buyers yet.'
        : `B against A: ${formatLift(r.lift)}, but only ${sure}% sure; a winner needs 95%.`,
  };
}
