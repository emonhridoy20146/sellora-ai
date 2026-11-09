import type { ReviewFlag, StoreText } from './schemas.js';

/**
 * The automatic check before a super-admin reviews a store. It never decides: it points the
 * reviewer at words that often mean a product Sellora does not allow (Bangladeshi law and
 * payment and courier partner rules) or a copied brand. Terms are matched as whole words in
 * English and Banglish, and as text in Bangla (Bangla has no reliable word boundaries here).
 */
interface Rule {
  label: string;
  reason: string;
  latin: string[];
  bangla: string[];
}

const RULES: Rule[] = [
  {
    label: 'Drugs',
    reason: 'Narcotics are illegal to sell.',
    latin: ['yaba', 'ganja', 'heroin', 'cocaine', 'phensedyl', 'weed', 'marijuana', 'cannabis'],
    bangla: ['ইয়াবা', 'গাঁজা', 'হেরোইন', 'ফেনসিডিল'],
  },
  {
    label: 'Weapons',
    reason: 'Firearms, ammunition and explosives need a licence and are not allowed.',
    latin: ['gun', 'pistol', 'revolver', 'rifle', 'ammunition', 'bullets', 'explosive'],
    bangla: ['পিস্তল', 'বন্দুক', 'গুলি', 'বিস্ফোরক'],
  },
  {
    label: 'Adult products',
    reason: 'Adult content and products are not allowed.',
    latin: ['porn', 'xxx', 'sex toy', 'sex toys', 'adult toy', 'adult toys', 'escort'],
    bangla: ['যৌন'],
  },
  {
    label: 'Copies of brands',
    reason: 'Replicas and copies of branded products break trademark law.',
    latin: ['replica', 'master copy', 'first copy', '1st copy', 'copy product', 'fake'],
    bangla: ['মাস্টার কপি', 'রেপ্লিকা', 'নকল'],
  },
  {
    label: 'Gambling',
    reason: 'Betting and gambling are illegal in Bangladesh.',
    latin: ['casino', 'betting', 'bet365', 'jackpot', 'lottery ticket'],
    bangla: ['জুয়া', 'বাজি'],
  },
  {
    label: 'Alcohol and tobacco',
    reason: 'Alcohol needs a licence; tobacco cannot be advertised or sold online.',
    latin: [
      'alcohol',
      'whisky',
      'whiskey',
      'vodka',
      'beer',
      'wine',
      'cigarette',
      'cigarettes',
      'vape',
    ],
    bangla: ['মদ', 'সিগারেট'],
  },
  {
    label: 'Prescription medicine',
    reason: 'Prescription medicine cannot be sold without a pharmacy licence.',
    latin: ['antibiotic', 'sleeping pill', 'sleeping pills', 'viagra', 'tramadol', 'sedative'],
    bangla: ['ঘুমের ওষুধ', 'অ্যান্টিবায়োটিক'],
  },
  {
    label: 'Documents and accounts',
    reason: 'Selling identity documents, certificates or online accounts is not allowed.',
    latin: ['fake nid', 'nid card', 'fake certificate', 'hacked account', 'facebook id sell'],
    bangla: ['জাল সনদ', 'ভুয়া'],
  },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const COMPILED = RULES.map((rule) => ({
  rule,
  latin: rule.latin.map((t) => ({
    term: t,
    re: new RegExp(`(?:^|[^a-z0-9])${escape(t)}(?:$|[^a-z0-9])`, 'i'),
  })),
}));

export type CheckedText = StoreText;

/** Flags for the reviewer, at most one per rule and place, and at most 50 in all. */
export function precheckStore(texts: CheckedText[]): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const t of texts) {
    const lower = t.text.normalize('NFC').toLowerCase();
    for (const { rule, latin } of COMPILED) {
      const term =
        latin.find((l) => l.re.test(lower))?.term ??
        rule.bangla.find((b) => lower.includes(b.normalize('NFC')));
      if (term)
        flags.push({
          where: t.where,
          label: t.label,
          term,
          reason: `${rule.label}: ${rule.reason}`,
        });
      if (flags.length >= 50) return flags;
    }
  }
  return flags;
}
