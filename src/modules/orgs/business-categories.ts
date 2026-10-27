/** Business categories drive store themes, AI reply libraries and onboarding defaults. */
export const BUSINESS_CATEGORIES = {
  fashion: { en: 'Fashion and clothing', bn: 'ফ্যাশন ও পোশাক' },
  beauty: { en: 'Beauty and cosmetics', bn: 'বিউটি ও কসমেটিক্স' },
  electronics: { en: 'Electronics and gadgets', bn: 'ইলেকট্রনিক্স ও গ্যাজেট' },
  grocery: { en: 'Grocery', bn: 'মুদি' },
  food: { en: 'Food and home kitchen', bn: 'খাবার ও হোম কিচেন' },
  home: { en: 'Home and living', bn: 'হোম ও লিভিং' },
  kids: { en: 'Kids and baby', bn: 'শিশু ও বেবি' },
  health: { en: 'Health and wellness', bn: 'স্বাস্থ্য ও সুস্থতা' },
  jewelry: { en: 'Jewelry and accessories', bn: 'জুয়েলারি ও এক্সেসরিজ' },
  handicrafts: { en: 'Handicrafts', bn: 'হস্তশিল্প' },
  books: { en: 'Books and stationery', bn: 'বই ও স্টেশনারি' },
  sports: { en: 'Sports and fitness', bn: 'খেলাধুলা ও ফিটনেস' },
  pets: { en: 'Pet supplies', bn: 'পোষা প্রাণী' },
  automotive: { en: 'Automotive', bn: 'অটোমোটিভ' },
  furniture: { en: 'Furniture', bn: 'ফার্নিচার' },
  digital: { en: 'Digital products', bn: 'ডিজিটাল পণ্য' },
  services: { en: 'Services', bn: 'সার্ভিস' },
  other: { en: 'Other', bn: 'অন্যান্য' },
} as const;

export type BusinessCategory = keyof typeof BUSINESS_CATEGORIES;
export const BUSINESS_CATEGORY_KEYS = Object.keys(BUSINESS_CATEGORIES) as [
  BusinessCategory,
  ...BusinessCategory[],
];
