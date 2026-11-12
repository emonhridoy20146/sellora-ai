import {
  blockId,
  type LandingLanguage,
  type LandingPackage,
  type LandingSection,
} from './blocks.js';

/**
 * The template library added in ADR 0031: 27 page templates in nine kinds of business, each
 * in English and Bangla. Words that are instructions to the business ("Write what this does
 * for the buyer.") are starter words: a page cannot go live while a shown section still has
 * one, so a template never puts a claim on a live page that the business did not write.
 * Sections that need the business's own pictures, videos or numbers start hidden.
 */

type Bi = Readonly<Record<LandingLanguage, string>>;
const bi = (en: string, bn: string): Bi => ({ en, bn });

export const TEMPLATE_CATEGORIES = [
  'general',
  'health',
  'beauty',
  'fashion',
  'gadgets',
  'food',
  'courses',
  'home',
  'kids',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_CATEGORY_LABEL: Record<TemplateCategory, string> = {
  general: 'Any product',
  health: 'Health and herbal',
  beauty: 'Beauty and skin care',
  fashion: 'Fashion',
  gadgets: 'Gadgets and electronics',
  food: 'Food',
  courses: 'Courses and events',
  home: 'Home and kitchen',
  kids: 'Kids and baby',
};

// ---------------------------------------------------------------- starter words

/** Instructions to the business, never words for shoppers. */
const S = {
  featureText: bi('Write what this does for the buyer.', 'এটি ক্রেতার কী কাজে লাগে লিখুন।'),
  points: [
    bi('Write the first point.', 'প্রথম পয়েন্ট লিখুন।'),
    bi('Write the second point.', 'দ্বিতীয় পয়েন্ট লিখুন।'),
    bi('Write the third point.', 'তৃতীয় পয়েন্ট লিখুন।'),
    bi('Write the fourth point.', 'চতুর্থ পয়েন্ট লিখুন।'),
  ],
  compare: [
    bi('Write the first thing you compare.', 'তুলনার প্রথম বিষয় লিখুন।'),
    bi('Write the second thing you compare.', 'তুলনার দ্বিতীয় বিষয় লিখুন।'),
    bi('Write the third thing you compare.', 'তুলনার তৃতীয় বিষয় লিখুন।'),
  ],
  ingredientText: bi('Write what this ingredient does.', 'এই উপাদানটি কী কাজ করে লিখুন।'),
  timelineText: bi(
    'Write what the buyer notices by then.',
    'এই সময়ের মধ্যে ক্রেতা কী পরিবর্তন দেখবেন লিখুন।',
  ),
  moduleText: bi('Write what this part teaches.', 'এই অংশে কী শেখানো হবে লিখুন।'),
  scheduleText: bi('Write what happens at this time.', 'এই সময়ে কী হবে লিখুন।'),
  forItem: bi('Write who this is for.', 'কাদের জন্য এটি, লিখুন।'),
  notForItem: bi('Write who should not buy it.', 'কাদের এটি কেনা উচিত নয়, লিখুন।'),
  statLabel: bi('Write what this real number counts.', 'এই আসল সংখ্যাটি কী গোনে লিখুন।'),
  quoteText: bi(
    'Write a few words from the expert or the founder.',
    'বিশেষজ্ঞ বা প্রতিষ্ঠাতার কয়েকটি কথা লিখুন।',
  ),
  imageTextBody: bi('Write about this picture.', 'এই ছবি সম্পর্কে লিখুন।'),
  aboutBody: bi(
    'Write your story: who you are and why you make this.',
    'আপনার গল্প লিখুন: আপনি কে এবং কেন এটি তৈরি করেন।',
  ),
  sizeNote: bi(
    'Replace these sample sizes with your own measurements.',
    'নমুনা মাপগুলোর জায়গায় আপনার পণ্যের আসল মাপ লিখুন।',
  ),
  announcement: bi(
    'Write your offer here, for example free delivery today.',
    'এখানে আপনার অফার লিখুন, যেমন আজ ফ্রি ডেলিভারি।',
  ),
  specValue: bi('Write the detail.', 'তথ্যটি লিখুন।'),
  learnLine: bi('Write in one line what the buyer learns.', 'ক্রেতা কী শিখবেন, এক লাইনে লিখুন।'),
  ctaText: bi(
    'Write one line that tells the buyer why to order today.',
    'আজই কেন অর্ডার করবেন, এক লাইনে লিখুন।',
  ),
  faq: {
    health: [
      bi(
        'Write the safety facts and who should ask a doctor first.',
        'নিরাপত্তার তথ্য এবং কাদের আগে ডাক্তারের পরামর্শ নেওয়া উচিত, লিখুন।',
      ),
      bi(
        'Write what buyers can honestly expect, and when.',
        'ক্রেতারা সত্যিকারভাবে কী ফল আশা করতে পারেন এবং কবে, লিখুন।',
      ),
    ],
    beauty: [
      bi('Write which skin types it suits.', 'কোন ধরনের ত্বকে এটি মানানসই, লিখুন।'),
      bi('Write where the product comes from.', 'পণ্যটি কোথা থেকে আসে, লিখুন।'),
    ],
    fashion: [
      bi('Write your size exchange rule.', 'সাইজ বদলের নিয়ম লিখুন।'),
      bi('Write how close the colours are to the pictures.', 'ছবির সাথে রঙ কতটা মিলবে, লিখুন।'),
    ],
    gadgets: [
      bi('Write your warranty, or say there is none.', 'ওয়ারেন্টি লিখুন, না থাকলে তা-ও লিখুন।'),
      bi('Write which devices it works with.', 'কোন কোন ডিভাইসে এটি চলে, লিখুন।'),
    ],
    food: [
      bi(
        'Write how long it keeps and how to store it.',
        'কত দিন ভালো থাকে এবং কীভাবে রাখতে হয়, লিখুন।',
      ),
      bi(
        'Write where you deliver and how long it takes.',
        'কোথায় ডেলিভারি দেন এবং কত দিন লাগে, লিখুন।',
      ),
    ],
    courses: [
      bi(
        'Write how buyers get access after ordering.',
        'অর্ডারের পর ক্রেতা কীভাবে অ্যাক্সেস পাবেন, লিখুন।',
      ),
      bi('Write whether a certificate is given.', 'সার্টিফিকেট দেওয়া হয় কি না, লিখুন।'),
      bi('Write how students ask questions.', 'শিক্ষার্থীরা কীভাবে প্রশ্ন করবেন, লিখুন।'),
    ],
    home: [
      bi('Write the size and what fits in it.', 'মাপ এবং এতে কী কী আঁটে, লিখুন।'),
      bi('Write how to clean and care for it.', 'কীভাবে পরিষ্কার ও যত্ন নিতে হয়, লিখুন।'),
    ],
    kids: [
      bi('Write the age range.', 'কোন বয়সের জন্য, লিখুন।'),
      bi('Write the materials and safety facts.', 'উপাদান ও নিরাপত্তার তথ্য লিখুন।'),
    ],
  },
} as const;

const FAQ_QUESTIONS: Record<Exclude<TemplateCategory, 'general'>, Bi[]> = {
  health: [
    bi('Is it safe to use?', 'এটি ব্যবহার কি নিরাপদ?'),
    bi('When will I see results?', 'কবে ফল পাব?'),
  ],
  beauty: [
    bi('Does it suit my skin?', 'আমার ত্বকে কি মানাবে?'),
    bi('Is it original?', 'এটি কি অরিজিনাল?'),
  ],
  fashion: [
    bi('Can I change the size?', 'সাইজ কি বদলানো যাবে?'),
    bi('Is the colour the same as the picture?', 'রঙ কি ছবির মতোই?'),
  ],
  gadgets: [
    bi('Is there a warranty?', 'ওয়ারেন্টি আছে কি?'),
    bi('Will it work with my device?', 'আমার ডিভাইসে কি চলবে?'),
  ],
  food: [
    bi('How long does it stay fresh?', 'কত দিন ভালো থাকে?'),
    bi('Where do you deliver?', 'কোথায় ডেলিভারি দেন?'),
  ],
  courses: [
    bi('How do I get access?', 'কীভাবে অ্যাক্সেস পাব?'),
    bi('Is there a certificate?', 'সার্টিফিকেট আছে কি?'),
    bi('Can I ask questions?', 'প্রশ্ন করা যাবে কি?'),
  ],
  home: [bi('What size is it?', 'এর মাপ কত?'), bi('How do I clean it?', 'কীভাবে পরিষ্কার করব?')],
  kids: [
    bi('What age is it for?', 'কোন বয়সের জন্য?'),
    bi('Is it safe for children?', 'শিশুদের জন্য কি নিরাপদ?'),
  ],
};

/** Every starter word of the library, in both languages. */
export const LIBRARY_STARTERS: readonly string[] = (() => {
  const all: Bi[] = [
    S.featureText,
    ...S.points,
    ...S.compare,
    S.ingredientText,
    S.timelineText,
    S.moduleText,
    S.scheduleText,
    S.forItem,
    S.notForItem,
    S.statLabel,
    S.quoteText,
    S.imageTextBody,
    S.aboutBody,
    S.sizeNote,
    S.announcement,
    S.specValue,
    S.learnLine,
    S.ctaText,
    ...Object.values(S.faq).flat(),
  ];
  return all.flatMap((b) => [b.en, b.bn]);
})();

// ---------------------------------------------------------------- the kit

/** Words the older templates already have, passed in so both stay one set. */
export interface BaseWords {
  orderNow: string;
  offerBadge: string;
  heroSub: string;
  whyTitle: string;
  benefits: { title: string; text: string }[];
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

export interface LibraryProduct {
  id: string;
  name: string;
  description: string;
}

const on = { enabled: true, hideOn: 'none' as const };
const off = { enabled: false, hideOn: 'none' as const };

/** Builds sections in one language for one product. */
export class Kit {
  constructor(
    readonly lang: LandingLanguage,
    readonly w: BaseWords,
    readonly product: LibraryProduct,
  ) {}

  t(b: Bi): string {
    return b[this.lang];
  }

  hero(sub?: Bi): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'hero',
      heading: this.product.name.slice(0, 120),
      subheading: sub ? this.t(sub) : this.w.heroSub,
      badge: this.w.offerBadge,
      buttonLabel: this.w.orderNow,
      image: null,
      showPrice: true,
    };
  }

  videoHero(sub?: Bi): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'video_hero',
      heading: this.product.name.slice(0, 120),
      subheading: sub ? this.t(sub) : this.w.heroSub,
      url: '',
      buttonLabel: this.w.orderNow,
    };
  }

  announcement(tone: 'offer' | 'info' | 'urgent' = 'offer'): LandingSection {
    return { id: blockId(), ...on, type: 'announcement', text: this.t(S.announcement), tone };
  }

  gallery(title = bi('', '')): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'gallery',
      title: this.t(title),
      source: 'product',
      images: [],
    };
  }

  video(title: Bi): LandingSection {
    return { id: blockId(), ...off, type: 'video', title: this.t(title), url: '' };
  }

  benefits(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'benefits',
      title: this.w.whyTitle,
      items: this.w.benefits,
    };
  }

  features(
    title: Bi,
    items: { icon: 'truck' | 'cash' | 'return' | 'support' | 'shield' | 'gift'; title: Bi }[],
  ): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'features',
      title: this.t(title),
      items: items.map((x) => ({
        icon: x.icon,
        title: this.t(x.title),
        text: this.t(S.featureText),
      })),
    };
  }

  checklist(title: Bi, count = 4): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'checklist',
      title: this.t(title),
      items: S.points.slice(0, count).map((p) => this.t(p)),
    };
  }

  comparison(title: Bi, ours: Bi, others: Bi): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'comparison',
      title: this.t(title),
      ourLabel: this.t(ours),
      otherLabel: this.t(others),
      rows: S.compare.map((c) => ({ label: this.t(c), ours: '✓', others: '✗' })),
    };
  }

  ingredients(title: Bi, names: Bi[]): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'ingredients',
      title: this.t(title),
      items: names.map((n) => ({ name: this.t(n), text: this.t(S.ingredientText), image: null })),
    };
  }

  timeline(title: Bi, labels: Bi[], text: Bi = S.timelineText): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'timeline',
      title: this.t(title),
      items: labels.map((l) => ({ label: this.t(l), text: this.t(text) })),
    };
  }

  whoFor(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'who_for',
      title: this.t(bi('Is it right for you?', 'এটি কি আপনার জন্য?')),
      forTitle: this.t(bi('Made for', 'যাদের জন্য')),
      forItems: [this.t(S.forItem)],
      notForTitle: this.t(bi('Not for', 'যাদের জন্য নয়')),
      notForItems: [this.t(S.notForItem)],
    };
  }

  stats(): LandingSection {
    return {
      id: blockId(),
      ...off,
      type: 'stats',
      title: '',
      items: [
        { value: '0', label: this.t(S.statLabel) },
        { value: '0', label: this.t(S.statLabel) },
      ],
    };
  }

  ordersToday(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'orders_today',
      text: this.t(
        bi(
          '{count} people ordered from this page today',
          'আজ এই পেজ থেকে {count} জন অর্ডার করেছেন',
        ),
      ),
      minCount: 5,
    };
  }

  videoReviews(): LandingSection {
    return {
      id: blockId(),
      ...off,
      type: 'video_reviews',
      title: this.w.reviewsTitle,
      items: [{ url: '', name: '' }],
    };
  }

  reviews(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'reviews',
      title: this.w.reviewsTitle,
      items: this.w.reviews.map((r) => ({ ...r, rating: 5, image: null })),
    };
  }

  quote(role: Bi): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'quote',
      text: this.t(S.quoteText),
      name: '',
      role: this.t(role),
      image: null,
    };
  }

  certificates(): LandingSection {
    return {
      id: blockId(),
      ...off,
      type: 'certificates',
      title: this.t(bi('Certificates and approvals', 'সার্টিফিকেট ও অনুমোদন')),
      items: [],
    };
  }

  imageText(heading: Bi, imageSide: 'left' | 'right' = 'left'): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'image_text',
      heading: this.t(heading),
      body: this.t(S.imageTextBody),
      image: null,
      imageSide,
    };
  }

  about(heading: Bi): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'about',
      heading: this.t(heading),
      body: this.t(S.aboutBody),
      image: null,
    };
  }

  sizeChart(kind: 'clothes' | 'shoes'): LandingSection {
    const clothes = kind === 'clothes';
    return {
      id: blockId(),
      ...on,
      type: 'size_chart',
      title: this.t(bi('Size chart', 'সাইজ চার্ট')),
      columns: clothes
        ? [
            this.t(bi('Size', 'সাইজ')),
            this.t(bi('Chest (in)', 'বুক (ইঞ্চি)')),
            this.t(bi('Length (in)', 'লম্বা (ইঞ্চি)')),
          ]
        : [this.t(bi('Size', 'সাইজ')), this.t(bi('Foot length (cm)', 'পায়ের দৈর্ঘ্য (সেমি)'))],
      rows: clothes
        ? [
            { cells: ['M', '38', '28'] },
            { cells: ['L', '40', '29'] },
            { cells: ['XL', '42', '30'] },
          ]
        : [{ cells: ['40', '25'] }, { cells: ['41', '26'] }, { cells: ['42', '26.5'] }],
      note: this.t(S.sizeNote),
    };
  }

  packagesSection(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'packages',
      heading: this.t(bi('Choose your package', 'আপনার প্যাকেজ বেছে নিন')),
      text: '',
    };
  }

  paymentMethods(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'payment_methods',
      heading: this.t(bi('Pay the way you like', 'যেভাবে খুশি টাকা দিন')),
      text: this.t(
        bi('Choose how to pay when you order.', 'অর্ডারের সময় পেমেন্টের উপায় বেছে নিন।'),
      ),
    };
  }

  couponBanner(): LandingSection {
    return {
      id: blockId(),
      ...off,
      type: 'coupon_banner',
      heading: this.t(bi('Use this code for a discount', 'ছাড় পেতে এই কোডটি ব্যবহার করুন')),
      code: '',
      text: '',
    };
  }

  cta(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'call_to_action',
      heading: this.w.formHeading,
      text: this.t(S.ctaText),
      buttonLabel: this.w.orderNow,
    };
  }

  location(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'location',
      heading: this.t(bi('Where to find us', 'আমাদের ঠিকানা')),
      address: '',
      hours: '',
      mapUrl: '',
    };
  }

  spacer(): LandingSection {
    return { id: blockId(), ...on, type: 'spacer', size: 'medium', line: true };
  }

  problemSolution(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'problem_solution',
      problemTitle: this.w.problemTitle,
      problem: this.w.problem,
      solutionTitle: this.w.solutionTitle,
      solution: this.w.solution,
      image: null,
    };
  }

  steps(title?: Bi): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'steps',
      title: title ? this.t(title) : this.w.stepsTitle,
      steps: this.w.steps.map((text) => ({ text })),
    };
  }

  specs(labels: Bi[]): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'specs',
      title: this.t(bi('Details', 'বিস্তারিত')),
      rows: labels.map((l) => ({ label: this.t(l), value: this.t(S.specValue) })),
    };
  }

  beforeAfter(): LandingSection {
    return {
      id: blockId(),
      ...off,
      type: 'before_after',
      title: this.t(bi('Before and after', 'আগে ও পরে')),
      before: null,
      after: null,
      caption: '',
    };
  }

  countdown(days = 3): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'countdown',
      heading: this.w.countdown,
      endsAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      endedText: this.w.ended,
    };
  }

  stock(): LandingSection {
    return { id: blockId(), ...on, type: 'stock_left', text: this.w.stockLeft, threshold: 10 };
  }

  price(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'price',
      heading: this.w.priceHeading,
      note: this.w.priceNote,
    };
  }

  guarantee(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'guarantee',
      title: this.w.guaranteeTitle,
      items: this.w.guarantees,
    };
  }

  delivery(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'delivery',
      heading: this.w.deliveryHeading,
      text: this.w.deliveryText,
      showAreas: true,
    };
  }

  contact(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'contact',
      heading: this.w.contactHeading,
      text: this.w.contactText,
      call: true,
      whatsapp: true,
    };
  }

  form(): LandingSection {
    return {
      id: blockId(),
      ...on,
      type: 'order_form',
      heading: this.w.formHeading,
      subheading: this.w.formSub,
      buttonLabel: this.w.confirm,
    };
  }

  /** The kind of business's own questions, then one general question. */
  faq(category: TemplateCategory): LandingSection {
    const general = this.w.faq;
    const items =
      category === 'general'
        ? general
        : category === 'courses'
          ? FAQ_QUESTIONS.courses.map((q, i) => ({
              question: this.t(q),
              answer: this.t(S.faq.courses[i]!),
            }))
          : [
              ...FAQ_QUESTIONS[category].map((q, i) => ({
                question: this.t(q),
                answer: this.t(S.faq[category][i]!),
              })),
              general[1]!,
            ];
    return { id: blockId(), ...on, type: 'faq', title: this.w.faqTitle, items };
  }
}

// ---------------------------------------------------------------- the templates

export interface LibraryTemplate {
  key: string;
  category: TemplateCategory;
  name: string;
  description: string;
  /** Packages to start with (the business sets the prices); none without a packages section. */
  packages?: readonly { label: Bi; quantity: number; badge?: Bi }[];
  sections: (k: Kit) => LandingSection[];
}

const PIECES = [
  { label: bi('1 piece', '১টি'), quantity: 1 },
  { label: bi('2 pieces', '২টি'), quantity: 2, badge: bi('Popular', 'জনপ্রিয়') },
  { label: bi('3 pieces', '৩টি'), quantity: 3 },
];

const LIBRARY_LIST = [
  // ---- any product
  {
    key: 'video_sales',
    category: 'general',
    name: 'Video sales page',
    description: 'Opens with your product video, then reasons to buy, packages and the order form.',
    packages: PIECES,
    sections: (k) => [
      k.videoHero(),
      k.checklist(bi('Why buy it', 'কেন কিনবেন')),
      k.videoReviews(),
      k.packagesSection(),
      k.guarantee(),
      k.form(),
      k.faq('general'),
    ],
  },
  {
    key: 'bundle_offer',
    category: 'general',
    name: 'Bundle offer',
    description: 'Sells more per order: package cards, what buyers save, and how to pay.',
    packages: PIECES,
    sections: (k) => [
      k.announcement(),
      k.hero(),
      k.packagesSection(),
      k.benefits(),
      k.paymentMethods(),
      k.cta(),
      k.form(),
      k.faq('general'),
      k.contact(),
    ],
  },
  {
    key: 'flash_sale',
    category: 'general',
    name: 'Flash sale',
    description: 'A short sale page with a countdown, real orders today, stock left and a coupon.',
    sections: (k) => [
      k.announcement('urgent'),
      k.hero(),
      k.countdown(1),
      k.ordersToday(),
      k.price(),
      k.stock(),
      k.couponBanner(),
      k.form(),
      k.delivery(),
    ],
  },
  // ---- health and herbal
  {
    key: 'herbal_remedy',
    category: 'health',
    name: 'Herbal remedy',
    description: 'The problem, what is inside, what to expect week by week, and who it is for.',
    sections: (k) => [
      k.hero(),
      k.problemSolution(),
      k.ingredients(bi('What is inside', 'ভেতরে যা আছে'), [
        bi('Ingredient 1', 'উপাদান ১'),
        bi('Ingredient 2', 'উপাদান ২'),
        bi('Ingredient 3', 'উপাদান ৩'),
      ]),
      k.timeline(bi('What to expect', 'কী আশা করবেন'), [
        bi('Week 1', '১ম সপ্তাহ'),
        bi('Week 2', '২য় সপ্তাহ'),
        bi('Week 4', '৪র্থ সপ্তাহ'),
      ]),
      k.steps(),
      k.whoFor(),
      k.certificates(),
      k.reviews(),
      k.guarantee(),
      k.form(),
      k.faq('health'),
    ],
  },
  {
    key: 'health_device',
    category: 'health',
    name: 'Health device',
    description: 'For machines and aids: features, details, how to use and a comparison.',
    sections: (k) => [
      k.hero(),
      k.video(bi('See how it works', 'কীভাবে কাজ করে দেখুন')),
      k.features(bi('Features', 'ফিচারসমূহ'), [
        { icon: 'shield', title: bi('Accurate', 'নির্ভুল') },
        { icon: 'support', title: bi('Easy to use', 'ব্যবহার সহজ') },
        { icon: 'gift', title: bi('In the box', 'বক্সে যা থাকছে') },
      ]),
      k.specs([bi('Model', 'মডেল'), bi('Power', 'পাওয়ার'), bi('Warranty', 'ওয়ারেন্টি')]),
      k.steps(),
      k.comparison(bi('Why this one', 'কেন এটি'), bi('This', 'এটি'), bi('Others', 'অন্যগুলো')),
      k.guarantee(),
      k.form(),
      k.faq('health'),
    ],
  },
  {
    key: 'supplement',
    category: 'health',
    name: 'Supplement',
    description: 'Key points, ingredients, an expert’s words and packages for a course of use.',
    packages: [
      { label: bi('1 month', '১ মাস'), quantity: 1 },
      { label: bi('2 months', '২ মাস'), quantity: 2, badge: bi('Popular', 'জনপ্রিয়') },
      { label: bi('3 months', '৩ মাস'), quantity: 3 },
    ],
    sections: (k) => [
      k.hero(),
      k.checklist(bi('Why people take it', 'কেন সবাই খান')),
      k.ingredients(bi('Ingredients', 'উপাদান'), [
        bi('Ingredient 1', 'উপাদান ১'),
        bi('Ingredient 2', 'উপাদান ২'),
      ]),
      k.quote(bi('Nutritionist', 'পুষ্টিবিদ')),
      k.stats(),
      k.packagesSection(),
      k.reviews(),
      k.form(),
      k.faq('health'),
    ],
  },
  // ---- beauty
  {
    key: 'skincare_routine',
    category: 'beauty',
    name: 'Skin care routine',
    description:
      'Ingredients, the routine step by step, who it suits and before-and-after pictures.',
    packages: PIECES,
    sections: (k) => [
      k.hero(),
      k.beforeAfter(),
      k.ingredients(bi('Key ingredients', 'মূল উপাদান'), [
        bi('Ingredient 1', 'উপাদান ১'),
        bi('Ingredient 2', 'উপাদান ২'),
        bi('Ingredient 3', 'উপাদান ৩'),
      ]),
      k.steps(bi('Your routine', 'ব্যবহারের ধাপ')),
      k.whoFor(),
      k.reviews(),
      k.packagesSection(),
      k.form(),
      k.faq('beauty'),
    ],
  },
  {
    key: 'beauty_glow',
    category: 'beauty',
    name: 'Glow video page',
    description: 'A video first, benefits, video reviews, the price and real orders today.',
    sections: (k) => [
      k.videoHero(),
      k.benefits(),
      k.beforeAfter(),
      k.videoReviews(),
      k.price(),
      k.ordersToday(),
      k.form(),
      k.faq('beauty'),
    ],
  },
  {
    key: 'cosmetics_combo',
    category: 'beauty',
    name: 'Cosmetics combo',
    description: 'For sets and combos: pictures, packages, what is in it and guarantees.',
    packages: PIECES,
    sections: (k) => [
      k.announcement(),
      k.hero(),
      k.gallery(),
      k.packagesSection(),
      k.features(bi('In the set', 'সেটে যা আছে'), [
        { icon: 'gift', title: bi('Item 1', 'আইটেম ১') },
        { icon: 'gift', title: bi('Item 2', 'আইটেম ২') },
        { icon: 'gift', title: bi('Item 3', 'আইটেম ৩') },
      ]),
      k.reviews(),
      k.guarantee(),
      k.form(),
      k.contact(),
    ],
  },
  // ---- fashion
  {
    key: 'fashion_drop',
    category: 'fashion',
    name: 'New collection',
    description: 'Pictures first, the fabric, a size chart, reviews and delivery.',
    sections: (k) => [
      k.hero(),
      k.gallery(),
      k.features(bi('Fabric and fit', 'কাপড় ও ফিটিং'), [
        { icon: 'shield', title: bi('Fabric', 'কাপড়') },
        { icon: 'gift', title: bi('Stitching', 'সেলাই') },
        { icon: 'return', title: bi('Easy size change', 'সহজে সাইজ বদল') },
      ]),
      k.sizeChart('clothes'),
      k.reviews(),
      k.delivery(),
      k.form(),
      k.faq('fashion'),
    ],
  },
  {
    key: 'festive_wear',
    category: 'fashion',
    name: 'Eid and festive wear',
    description:
      'Saree, panjabi or three-piece for the season: pictures, the story, sizes, packages.',
    packages: [
      { label: bi('1 piece', '১টি'), quantity: 1 },
      { label: bi('Pair (2 pieces)', 'জোড়া (২টি)'), quantity: 2, badge: bi('Gift', 'উপহার') },
    ],
    sections: (k) => [
      k.announcement(),
      k.hero(),
      k.gallery(),
      k.imageText(bi('Made for the occasion', 'উৎসবের জন্য তৈরি')),
      k.sizeChart('clothes'),
      k.packagesSection(),
      k.form(),
      k.contact(),
    ],
  },
  {
    key: 'shoes_bags',
    category: 'fashion',
    name: 'Shoes and bags',
    description: 'Pictures, details, a shoe size chart and why yours are better.',
    sections: (k) => [
      k.hero(),
      k.gallery(),
      k.specs([bi('Material', 'উপাদান'), bi('Sole', 'সোল'), bi('Colours', 'রঙ')]),
      k.sizeChart('shoes'),
      k.comparison(bi('Why ours', 'কেন আমাদেরটি'), bi('Ours', 'আমাদের'), bi('Market', 'বাজারের')),
      k.guarantee(),
      k.form(),
      k.faq('fashion'),
    ],
  },
  // ---- gadgets
  {
    key: 'gadget_review',
    category: 'gadgets',
    name: 'Gadget showcase',
    description: 'A video, the features, full details, a comparison and the warranty.',
    sections: (k) => [
      k.videoHero(),
      k.features(bi('Features', 'ফিচারসমূহ'), [
        { icon: 'shield', title: bi('Build', 'বিল্ড') },
        { icon: 'support', title: bi('Battery', 'ব্যাটারি') },
        { icon: 'gift', title: bi('In the box', 'বক্সে যা থাকছে') },
      ]),
      k.specs([
        bi('Model', 'মডেল'),
        bi('Battery', 'ব্যাটারি'),
        bi('Connectivity', 'কানেক্টিভিটি'),
        bi('Warranty', 'ওয়ারেন্টি'),
      ]),
      k.comparison(bi('Compared', 'তুলনা'), bi('This', 'এটি'), bi('Others', 'অন্যগুলো')),
      k.videoReviews(),
      k.guarantee(),
      k.form(),
      k.faq('gadgets'),
    ],
  },
  {
    key: 'phone_accessory',
    category: 'gadgets',
    name: 'Phone accessory',
    description: 'For chargers, cases and earphones: key points, details, packages, payment.',
    packages: PIECES,
    sections: (k) => [
      k.hero(),
      k.checklist(bi('Why this one', 'কেন এটি')),
      k.gallery(),
      k.specs([
        bi('Works with', 'যেসব ফোনে চলে'),
        bi('Cable', 'ক্যাবল'),
        bi('Warranty', 'ওয়ারেন্টি'),
      ]),
      k.packagesSection(),
      k.paymentMethods(),
      k.form(),
      k.faq('gadgets'),
    ],
  },
  {
    key: 'smart_home',
    category: 'gadgets',
    name: 'Smart home device',
    description: 'The everyday problem it solves, how to set it up, and what it can do.',
    sections: (k) => [
      k.hero(),
      k.problemSolution(),
      k.steps(bi('Set it up', 'সেটআপের ধাপ')),
      k.features(bi('What it can do', 'যা যা করতে পারে'), [
        { icon: 'support', title: bi('Feature 1', 'ফিচার ১') },
        { icon: 'shield', title: bi('Feature 2', 'ফিচার ২') },
        { icon: 'gift', title: bi('Feature 3', 'ফিচার ৩') },
      ]),
      k.stats(),
      k.reviews(),
      k.form(),
      k.contact(),
    ],
  },
  // ---- food
  {
    key: 'homemade_food',
    category: 'food',
    name: 'Homemade food',
    description: 'Your story, what goes in, pictures, delivery areas and packages.',
    packages: [
      { label: bi('Small box', 'ছোট বক্স'), quantity: 1 },
      { label: bi('Family box', 'ফ্যামিলি বক্স'), quantity: 2, badge: bi('Popular', 'জনপ্রিয়') },
    ],
    sections: (k) => [
      k.hero(),
      k.about(bi('Made at home', 'ঘরে তৈরি')),
      k.ingredients(bi('What goes in', 'যা দিয়ে তৈরি'), [
        bi('Ingredient 1', 'উপাদান ১'),
        bi('Ingredient 2', 'উপাদান ২'),
      ]),
      k.gallery(),
      k.delivery(),
      k.packagesSection(),
      k.form(),
      k.faq('food'),
    ],
  },
  {
    key: 'organic_produce',
    category: 'food',
    name: 'Pure and organic',
    description:
      'For honey, ghee, dates or oil: where it comes from, what it is free of, a comparison.',
    sections: (k) => [
      k.hero(),
      k.imageText(bi('Where it comes from', 'কোথা থেকে আসে')),
      k.checklist(bi('Pure, with nothing added', 'খাঁটি, কোনো মিশ্রণ নেই')),
      k.comparison(
        bi('Ours and the market’s', 'আমাদের আর বাজারের'),
        bi('Ours', 'আমাদের'),
        bi('Market', 'বাজারের'),
      ),
      k.certificates(),
      k.reviews(),
      k.form(),
      k.faq('food'),
    ],
  },
  {
    key: 'snacks_box',
    category: 'food',
    name: 'Snack box',
    description: 'A quick page for snacks and sweets: pictures, packages, orders today, delivery.',
    packages: PIECES,
    sections: (k) => [
      k.announcement(),
      k.hero(),
      k.gallery(),
      k.packagesSection(),
      k.ordersToday(),
      k.delivery(),
      k.form(),
      k.faq('food'),
    ],
  },
  // ---- courses and events
  {
    key: 'online_course',
    category: 'courses',
    name: 'Online course',
    description: 'Who it is for, what they learn, the modules, the teacher and how to pay.',
    sections: (k) => [
      k.hero(S.learnLine),
      k.whoFor(),
      k.checklist(bi('What you will learn', 'যা শিখবেন')),
      k.timeline(
        bi('Course plan', 'কোর্সের পরিকল্পনা'),
        [bi('Module 1', 'মডিউল ১'), bi('Module 2', 'মডিউল ২'), bi('Module 3', 'মডিউল ৩')],
        S.moduleText,
      ),
      k.quote(bi('Your teacher', 'আপনার শিক্ষক')),
      k.stats(),
      k.paymentMethods(),
      k.cta(),
      k.form(),
      k.faq('courses'),
    ],
  },
  {
    key: 'workshop_event',
    category: 'courses',
    name: 'Workshop or event',
    description: 'A countdown to the day, the host, the schedule and where it happens.',
    sections: (k) => [
      k.announcement('info'),
      k.hero(S.learnLine),
      k.countdown(7),
      k.about(bi('Your host', 'আয়োজক')),
      k.timeline(
        bi('Schedule', 'সময়সূচি'),
        [bi('10:00', '১০:০০'), bi('12:00', '১২:০০'), bi('15:00', '৩:০০')],
        S.scheduleText,
      ),
      k.location(),
      k.form(),
      k.faq('courses'),
    ],
  },
  {
    key: 'ebook_guide',
    category: 'courses',
    name: 'E-book or guide',
    description: 'What is inside, a look at the pages, what readers say and the price.',
    sections: (k) => [
      k.hero(S.learnLine),
      k.checklist(bi('Inside the book', 'বইয়ের ভেতরে')),
      k.imageText(bi('A look inside', 'ভেতরের এক ঝলক'), 'right'),
      k.reviews(),
      k.price(),
      k.form(),
      k.faq('courses'),
    ],
  },
  // ---- home and kitchen
  {
    key: 'kitchen_gadget',
    category: 'home',
    name: 'Kitchen gadget',
    description: 'Video first, the chore it saves, how to use it, features and details.',
    sections: (k) => [
      k.videoHero(),
      k.problemSolution(),
      k.steps(),
      k.features(bi('Why cooks like it', 'কেন রান্নাঘরে কাজে লাগে'), [
        { icon: 'shield', title: bi('Strong', 'মজবুত') },
        { icon: 'support', title: bi('Easy to clean', 'সহজে পরিষ্কার') },
        { icon: 'gift', title: bi('Saves time', 'সময় বাঁচায়') },
      ]),
      k.specs([bi('Material', 'উপাদান'), bi('Size', 'মাপ'), bi('Capacity', 'ধারণক্ষমতা')]),
      k.cta(),
      k.form(),
      k.faq('home'),
    ],
  },
  {
    key: 'home_decor',
    category: 'home',
    name: 'Home decor',
    description: 'Pictures in a real room, the details, delivery and a way to ask.',
    sections: (k) => [
      k.hero(),
      k.gallery(),
      k.imageText(bi('In your home', 'আপনার ঘরে')),
      k.specs([bi('Size', 'মাপ'), bi('Material', 'উপাদান'), bi('Colours', 'রঙ')]),
      k.delivery(),
      k.form(),
      k.contact(),
    ],
  },
  {
    key: 'cleaning_product',
    category: 'home',
    name: 'Cleaning product',
    description: 'Before and after, what it cleans, how to use it, and how it compares.',
    packages: PIECES,
    sections: (k) => [
      k.hero(),
      k.beforeAfter(),
      k.checklist(bi('What it cleans', 'যা যা পরিষ্কার করে')),
      k.steps(),
      k.comparison(
        bi('Compared', 'তুলনা'),
        bi('This', 'এটি'),
        bi('Usual cleaners', 'সাধারণ ক্লিনার'),
      ),
      k.packagesSection(),
      k.form(),
      k.faq('home'),
    ],
  },
  // ---- kids and baby
  {
    key: 'baby_care',
    category: 'kids',
    name: 'Baby care',
    description: 'Who it is for, what is in it, safety and what parents say.',
    sections: (k) => [
      k.hero(),
      k.whoFor(),
      k.ingredients(bi('Gentle ingredients', 'কোমল উপাদান'), [
        bi('Ingredient 1', 'উপাদান ১'),
        bi('Ingredient 2', 'উপাদান ২'),
      ]),
      k.certificates(),
      k.guarantee(),
      k.reviews(),
      k.form(),
      k.faq('kids'),
    ],
  },
  {
    key: 'kids_toys',
    category: 'kids',
    name: 'Toys',
    description: 'Pictures, what it teaches, age and materials, a video and packages.',
    packages: PIECES,
    sections: (k) => [
      k.hero(),
      k.gallery(),
      k.features(bi('Why kids love it', 'কেন শিশুরা ভালোবাসে'), [
        { icon: 'gift', title: bi('Fun', 'মজার') },
        { icon: 'shield', title: bi('Safe', 'নিরাপদ') },
        { icon: 'support', title: bi('Learns while playing', 'খেলতে খেলতে শেখা') },
      ]),
      k.specs([bi('Age', 'বয়স'), bi('Material', 'উপাদান'), bi('Battery', 'ব্যাটারি')]),
      k.video(bi('See it play', 'খেলার ভিডিও')),
      k.packagesSection(),
      k.form(),
      k.faq('kids'),
    ],
  },
  {
    key: 'school_supplies',
    category: 'kids',
    name: 'School set',
    description: 'For back-to-school sets: what is in the set, pictures, packages and delivery.',
    packages: PIECES,
    sections: (k) => [
      k.announcement(),
      k.hero(),
      k.checklist(bi('In the set', 'সেটে যা আছে')),
      k.gallery(),
      k.packagesSection(),
      k.delivery(),
      k.form(),
      k.faq('kids'),
    ],
  },
] as const satisfies readonly LibraryTemplate[];

export const LIBRARY_TEMPLATES: readonly LibraryTemplate[] = LIBRARY_LIST;
export type LibraryTemplateKey = (typeof LIBRARY_LIST)[number]['key'];
export const LIBRARY_TEMPLATE_KEYS: LibraryTemplateKey[] = LIBRARY_LIST.map((t) => t.key);

/** A library template's sections and packages for this product, in this language. */
export function libraryContent(
  template: LibraryTemplate,
  language: LandingLanguage,
  words: BaseWords,
  product: LibraryProduct,
): { sections: LandingSection[]; packages: LandingPackage[] } {
  const kit = new Kit(language, words, product);
  return {
    sections: template.sections(kit),
    packages: (template.packages ?? []).map((p) => ({
      id: blockId(),
      label: p.label[language],
      quantity: p.quantity,
      priceMinor: null,
      badge: p.badge?.[language] ?? '',
    })),
  };
}
