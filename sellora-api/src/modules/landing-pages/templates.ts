import type { FieldError } from '../../common/errors/app-error.js';
import {
  blockId,
  sectionTexts,
  type LandingContent,
  type LandingLanguage,
  type LandingSection,
} from './blocks.js';
import {
  LIBRARY_STARTERS,
  LIBRARY_TEMPLATE_KEYS,
  LIBRARY_TEMPLATES,
  libraryContent,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABEL,
  type TemplateCategory,
} from './template-library.js';

export { TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_LABEL, type TemplateCategory };

const BASE_KEYS = ['full_offer', 'problem_solution', 'quick_order'] as const;
type BaseKey = (typeof BASE_KEYS)[number];

/** Every built-in template: the first three (ADR 0016) and the library (ADR 0031). */
export type TemplateKey = BaseKey | (typeof LIBRARY_TEMPLATE_KEYS)[number];
export const TEMPLATE_KEYS = [...BASE_KEYS, ...LIBRARY_TEMPLATE_KEYS] as [
  TemplateKey,
  ...TemplateKey[],
];

export interface TemplateInfo {
  key: TemplateKey;
  category: TemplateCategory;
  name: string;
  description: string;
}

export const TEMPLATES: readonly TemplateInfo[] = [
  {
    key: 'full_offer',
    category: 'general',
    name: 'Full offer page',
    description:
      'Big offer, pictures, benefits, details, reviews, guarantees and questions, then the order form. Suits most products.',
  },
  {
    key: 'problem_solution',
    category: 'general',
    name: 'Problem and solution',
    description:
      'Starts from the problem the product solves, then how to use it and what buyers say, with a countdown. Suits health, beauty and home products.',
  },
  {
    key: 'quick_order',
    category: 'general',
    name: 'Quick order',
    description:
      'A short page: the offer, the order form straight away, delivery and questions. Suits low-priced and impulse products.',
  },
  ...LIBRARY_TEMPLATES.map((t) => ({
    key: t.key as TemplateKey,
    category: t.category,
    name: t.name,
    description: t.description,
  })),
];

/** The product a new page is made for. */
export interface TemplateProduct {
  id: string;
  name: string;
  description: string;
}

interface Words {
  orderNow: string;
  offerBadge: string;
  heroSub: string;
  whyTitle: string;
  benefits: { title: string; text: string }[];
  detailsTitle: string;
  descriptionLabel: string;
  reviewsTitle: string;
  reviews: { name: string; text: string }[];
  guaranteeTitle: string;
  guarantees: { icon: 'cash' | 'truck' | 'return' | 'shield'; title: string; text: string }[];
  faqTitle: string;
  faq: { question: string; answer: string }[];
  formHeading: string;
  formSub: string;
  confirm: string;
  problemTitle: string;
  problem: string;
  solutionTitle: string;
  solution: string;
  stepsTitle: string;
  steps: string[];
  countdown: string;
  ended: string;
  stockLeft: string;
  deliveryHeading: string;
  deliveryText: string;
  contactHeading: string;
  contactText: string;
  priceHeading: string;
  priceNote: string;
}

const WORDS: Record<LandingLanguage, Words> = {
  en: {
    orderNow: 'Order now',
    offerBadge: 'Special offer',
    heroSub: 'Cash on delivery anywhere in Bangladesh. Check the parcel before you pay.',
    whyTitle: 'Why people choose it',
    benefits: [
      { title: 'Quality you can see', text: 'Write what makes this product good.' },
      { title: 'Made for everyday use', text: 'Write who it is for and how it helps.' },
      { title: 'Good value', text: 'Write why the price is worth it.' },
    ],
    detailsTitle: 'Details',
    descriptionLabel: 'About',
    reviewsTitle: 'What buyers say',
    reviews: [
      { name: 'A happy buyer', text: 'Replace this with a real review from a customer.' },
      { name: 'Another buyer', text: 'Real words from real buyers sell better than anything.' },
    ],
    guaranteeTitle: 'Order without worry',
    guarantees: [
      { icon: 'cash', title: 'Cash on delivery', text: 'Pay when the parcel reaches you.' },
      { icon: 'truck', title: 'Home delivery', text: 'Delivered to your door across the country.' },
      {
        icon: 'return',
        title: 'Easy returns',
        text: 'Tell us within 3 days if something is wrong.',
      },
    ],
    faqTitle: 'Questions',
    faq: [
      {
        question: 'How long does delivery take?',
        answer: 'Usually 1 to 2 days inside Dhaka and 2 to 4 days elsewhere.',
      },
      {
        question: 'Can I check the product before paying?',
        answer: 'Yes. Open the parcel in front of the delivery person, then pay.',
      },
      {
        question: 'How do I order?',
        answer: 'Fill in the form below. We call to confirm before sending.',
      },
    ],
    formHeading: 'Order now',
    formSub: 'Write your name, phone number and address. We call to confirm before sending.',
    confirm: 'Confirm order',
    problemTitle: 'Tired of this problem?',
    problem: 'Describe the problem your buyers have, in their own words.',
    solutionTitle: 'Here is the solution',
    solution: 'Explain how this product solves it.',
    stepsTitle: 'How to use',
    steps: ['Write the first step.', 'Write the second step.', 'Write the third step.'],
    countdown: 'Offer ends in',
    ended: 'This offer has ended. Ask us about the current price.',
    stockLeft: 'Only {count} left in stock',
    deliveryHeading: 'Delivery',
    deliveryText: 'We deliver across Bangladesh. Pay cash when the parcel reaches you.',
    contactHeading: 'Questions? Talk to us',
    contactText: 'Call or message us and we will help you choose.',
    priceHeading: 'Offer price',
    priceNote: 'Delivery charge is added at checkout.',
  },
  bn: {
    orderNow: 'এখনই অর্ডার করুন',
    offerBadge: 'বিশেষ অফার',
    heroSub: 'সারা বাংলাদেশে ক্যাশ অন ডেলিভারি। পণ্য দেখে টাকা দিন।',
    whyTitle: 'কেন সবাই এটি বেছে নেয়',
    benefits: [
      { title: 'চোখে পড়ার মতো মান', text: 'পণ্যটি কেন ভালো তা লিখুন।' },
      { title: 'প্রতিদিনের ব্যবহারের জন্য', text: 'কার জন্য এবং কীভাবে কাজে লাগে লিখুন।' },
      { title: 'দামের তুলনায় সেরা', text: 'দামটি কেন যুক্তিসঙ্গত তা লিখুন।' },
    ],
    detailsTitle: 'বিস্তারিত',
    descriptionLabel: 'পণ্য সম্পর্কে',
    reviewsTitle: 'ক্রেতারা যা বলছেন',
    reviews: [
      { name: 'একজন সন্তুষ্ট ক্রেতা', text: 'এখানে একজন ক্রেতার আসল রিভিউ লিখুন।' },
      { name: 'আরেকজন ক্রেতা', text: 'আসল ক্রেতার কথা সবচেয়ে বেশি বিশ্বাস জাগায়।' },
    ],
    guaranteeTitle: 'নিশ্চিন্তে অর্ডার করুন',
    guarantees: [
      { icon: 'cash', title: 'ক্যাশ অন ডেলিভারি', text: 'পণ্য হাতে পেয়ে টাকা দিন।' },
      { icon: 'truck', title: 'হোম ডেলিভারি', text: 'সারা দেশে আপনার দরজায় পৌঁছে দিই।' },
      { icon: 'return', title: 'সহজ রিটার্ন', text: 'সমস্যা হলে ৩ দিনের মধ্যে জানান।' },
    ],
    faqTitle: 'প্রশ্ন ও উত্তর',
    faq: [
      {
        question: 'ডেলিভারি পেতে কত দিন লাগে?',
        answer: 'সাধারণত ঢাকার ভেতরে ১-২ দিন, ঢাকার বাইরে ২-৪ দিন।',
      },
      {
        question: 'টাকা দেওয়ার আগে পণ্য দেখা যাবে?',
        answer: 'হ্যাঁ। ডেলিভারি ম্যানের সামনে পার্সেল খুলে দেখে টাকা দিন।',
      },
      {
        question: 'কীভাবে অর্ডার করব?',
        answer: 'নিচের ফর্মটি পূরণ করুন। পাঠানোর আগে আমরা কল করে নিশ্চিত করব।',
      },
    ],
    formHeading: 'এখনই অর্ডার করুন',
    formSub: 'নাম, মোবাইল নম্বর ও ঠিকানা লিখুন। পাঠানোর আগে আমরা কল করে নিশ্চিত করব।',
    confirm: 'অর্ডার নিশ্চিত করুন',
    problemTitle: 'এই সমস্যায় ভুগছেন?',
    problem: 'আপনার ক্রেতাদের সমস্যাটি তাদের ভাষায় লিখুন।',
    solutionTitle: 'সমাধান এখানে',
    solution: 'এই পণ্য কীভাবে সমস্যার সমাধান করে তা লিখুন।',
    stepsTitle: 'ব্যবহারের নিয়ম',
    steps: ['প্রথম ধাপ লিখুন।', 'দ্বিতীয় ধাপ লিখুন।', 'তৃতীয় ধাপ লিখুন।'],
    countdown: 'অফার শেষ হতে বাকি',
    ended: 'অফারটি শেষ হয়েছে। বর্তমান দাম জানতে আমাদের সাথে যোগাযোগ করুন।',
    stockLeft: 'স্টকে মাত্র {count}টি বাকি',
    deliveryHeading: 'ডেলিভারি',
    deliveryText: 'সারা বাংলাদেশে ডেলিভারি দিই। পণ্য হাতে পেয়ে টাকা দিন।',
    contactHeading: 'প্রশ্ন আছে? আমাদের জানান',
    contactText: 'কল বা মেসেজ করুন, বেছে নিতে সাহায্য করব।',
    priceHeading: 'অফার মূল্য',
    priceNote: 'ডেলিভারি চার্জ অর্ডারের সময় যোগ হবে।',
  },
};

/**
 * The template words that are instructions to the business ("Write what makes this product
 * good.") or sample reviews, not words for shoppers. A page cannot go live while a shown
 * section still has one: shoppers would read the instruction, and a sample review on a live
 * page would be a made-up review.
 */
export const STARTER_TEXTS: ReadonlySet<string> = new Set([
  ...Object.values(WORDS).flatMap((w) => [
    ...w.benefits.map((b) => b.text),
    ...w.reviews.flatMap((r) => [r.name, r.text]),
    w.problem,
    w.solution,
    ...w.steps,
  ]),
  ...LIBRARY_STARTERS,
]);

const isStarter = (text: string) => STARTER_TEXTS.has(text.trim());

/** The shown sections that still have the template's starter words (empty when none do). */
export function starterTextProblems(content: LandingContent): FieldError[] {
  const errors: FieldError[] = [];
  content.sections.forEach((s, i) => {
    if (!s.enabled) return;
    const path = `content.sections.${i}`;
    if (s.type === 'reviews' && s.items.some((r) => isStarter(r.name) || isStarter(r.text)))
      errors.push({
        path,
        message: 'Replace the sample reviews with real ones from your buyers, or hide this section',
      });
    if (s.type === 'reviews') return;
    const words = sectionTexts(s);
    if (words.some(isStarter))
      errors.push({
        path,
        message: "Replace the template's sample words with your own, or hide this section",
      });
  });
  return errors;
}

const on = { enabled: true, hideOn: 'none' as const };

/** Splits a product description into short paragraphs for a text section. */
function descriptionText(description: string): string {
  return description.trim().slice(0, 3000);
}

/** A new page's content: the template's sections in the page's language, for this product. */
export function templateContent(
  key: TemplateKey,
  language: LandingLanguage,
  product: TemplateProduct,
): LandingContent {
  const w = WORDS[language];
  const library = LIBRARY_TEMPLATES.find((t) => t.key === key);
  if (library) {
    const { sections, packages } = libraryContent(library, language, w, product);
    return {
      sections,
      offer: { productId: product.id, packages, addOn: null, noteField: true },
      seo: { title: product.name.slice(0, 70), description: '', image: null, index: true },
      settings: { stickyButton: true, stickyLabel: w.orderNow },
    };
  }
  const base = key as BaseKey;
  const hero: LandingSection = {
    id: blockId(),
    ...on,
    type: 'hero',
    heading: product.name.slice(0, 120),
    subheading: w.heroSub,
    badge: w.offerBadge,
    buttonLabel: w.orderNow,
    image: null,
    showPrice: true,
  };
  const gallery: LandingSection = {
    id: blockId(),
    ...on,
    type: 'gallery',
    title: '',
    source: 'product',
    images: [],
  };
  const benefits: LandingSection = {
    id: blockId(),
    ...on,
    type: 'benefits',
    title: w.whyTitle,
    items: w.benefits,
  };
  const about: LandingSection | null = product.description.trim()
    ? {
        id: blockId(),
        ...on,
        type: 'text',
        heading: w.descriptionLabel,
        body: descriptionText(product.description),
      }
    : null;
  const reviews: LandingSection = {
    id: blockId(),
    ...on,
    type: 'reviews',
    title: w.reviewsTitle,
    items: w.reviews.map((r) => ({ ...r, rating: 5, image: null })),
  };
  const guarantee: LandingSection = {
    id: blockId(),
    ...on,
    type: 'guarantee',
    title: w.guaranteeTitle,
    items: w.guarantees,
  };
  const faq: LandingSection = {
    id: blockId(),
    ...on,
    type: 'faq',
    title: w.faqTitle,
    items: w.faq,
  };
  const stock: LandingSection = {
    id: blockId(),
    ...on,
    type: 'stock_left',
    text: w.stockLeft,
    threshold: 10,
  };
  const price: LandingSection = {
    id: blockId(),
    ...on,
    type: 'price',
    heading: w.priceHeading,
    note: w.priceNote,
  };
  const form: LandingSection = {
    id: blockId(),
    ...on,
    type: 'order_form',
    heading: w.formHeading,
    subheading: w.formSub,
    buttonLabel: w.confirm,
  };
  const delivery: LandingSection = {
    id: blockId(),
    ...on,
    type: 'delivery',
    heading: w.deliveryHeading,
    text: w.deliveryText,
    showAreas: true,
  };
  const contact: LandingSection = {
    id: blockId(),
    ...on,
    type: 'contact',
    heading: w.contactHeading,
    text: w.contactText,
    call: true,
    whatsapp: true,
  };

  let sections: LandingSection[];
  if (base === 'full_offer')
    sections = [
      hero,
      gallery,
      benefits,
      ...(about ? [about] : []),
      reviews,
      price,
      stock,
      guarantee,
      faq,
      form,
      contact,
    ];
  else if (base === 'problem_solution')
    sections = [
      hero,
      {
        id: blockId(),
        ...on,
        type: 'problem_solution',
        problemTitle: w.problemTitle,
        problem: w.problem,
        solutionTitle: w.solutionTitle,
        solution: w.solution,
        image: null,
      },
      benefits,
      {
        id: blockId(),
        ...on,
        type: 'steps',
        title: w.stepsTitle,
        steps: w.steps.map((text) => ({ text })),
      },
      reviews,
      {
        id: blockId(),
        ...on,
        type: 'countdown',
        heading: w.countdown,
        endsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        endedText: w.ended,
      },
      form,
      faq,
      contact,
    ];
  else sections = [hero, price, form, delivery, faq];

  return {
    sections,
    offer: { productId: product.id, packages: [], addOn: null, noteField: true },
    seo: { title: product.name.slice(0, 70), description: '', image: null, index: true },
    settings: { stickyButton: true, stickyLabel: w.orderNow },
  };
}
