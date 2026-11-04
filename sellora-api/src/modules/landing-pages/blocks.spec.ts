import { describe, expect, it } from 'vitest';
import {
  contentImages,
  contentTexts,
  dayKey,
  landingContentSchema,
  packageCharge,
  parseVideoUrl,
  publishProblems,
  slugProblem,
  withImageUrls,
  type LandingContent,
  type OfferProducts,
} from './blocks.js';
import { STARTER_TEXTS, TEMPLATE_KEYS, starterTextProblems, templateContent } from './templates.js';

const PRODUCT = { id: 'a'.repeat(24), name: 'Aloe Vera Gel', description: 'Cools the skin.' };
const ADDON = 'b'.repeat(24);
const VARIANT = 'c'.repeat(24);
const FILE = (n: number) => n.toString(16).padStart(24, 'f');

const ready: OfferProducts = {
  product: { active: true, currencyOk: true, variantIds: [VARIANT] },
  addOn: { active: true, currencyOk: true, variantIds: [VARIANT] },
};

function page(overrides: Partial<LandingContent> = {}): LandingContent {
  return {
    ...landingContentSchema.parse(templateContent('full_offer', 'en', PRODUCT)),
    ...overrides,
  };
}

describe('page addresses', () => {
  it('takes short lowercase words joined by single hyphens', () => {
    expect(slugProblem('aloe-offer')).toBeNull();
    expect(slugProblem('eid2026')).toBeNull();
    expect(slugProblem('a')).toBe('format');
    expect(slugProblem('Aloe')).toBe('format');
    expect(slugProblem('aloe--offer')).toBe('format');
    expect(slugProblem('-aloe')).toBe('format');
    expect(slugProblem('aloe-')).toBe('format');
    expect(slugProblem('aloe offer')).toBe('format');
    expect(slugProblem('x'.repeat(61))).toBe('format');
  });

  it("keeps the storefront's own paths free", () => {
    for (const s of ['products', 'cart', 'checkout', 'order', 'track', 'pages', 'api'])
      expect(slugProblem(s)).toBe('reserved');
  });
});

describe('video links', () => {
  it('reduces YouTube links of every shape to the video id', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=10',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'http://youtube.com/live/dQw4w9WgXcQ',
    ])
      expect(parseVideoUrl(url)).toEqual({ provider: 'youtube', id: 'dQw4w9WgXcQ' });
  });

  it('keeps Facebook video links in a canonical form', () => {
    expect(parseVideoUrl('https://m.facebook.com/shop/videos/1234567890/')).toEqual({
      provider: 'facebook',
      id: 'https://www.facebook.com/shop/videos/1234567890',
    });
    expect(parseVideoUrl('https://www.facebook.com/watch/?v=987654321')).toEqual({
      provider: 'facebook',
      id: 'https://www.facebook.com/watch/?v=987654321',
    });
    expect(parseVideoUrl('https://www.facebook.com/reel/555')).toEqual({
      provider: 'facebook',
      id: 'https://www.facebook.com/reel/555',
    });
  });

  it('refuses every other link, so pages cannot frame other sites', () => {
    for (const url of [
      'https://vimeo.com/123',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
      'https://www.youtube.com/watch?v=short',
      'https://www.facebook.com/shop/posts/1',
      'not a link',
    ])
      expect(parseVideoUrl(url)).toBeNull();
  });
});

describe('page content', () => {
  it('every template in both languages is valid content with one order form', () => {
    for (const key of TEMPLATE_KEYS)
      for (const lang of ['en', 'bn'] as const) {
        const content = landingContentSchema.parse(templateContent(key, lang, PRODUCT));
        expect(content.sections.filter((s) => s.type === 'order_form')).toHaveLength(1);
        expect(content.offer.productId).toBe(PRODUCT.id);
        expect(new Set(content.sections.map((s) => s.id)).size).toBe(content.sections.length);
        expect(publishProblems(content, ready)).toEqual([]);
      }
  });

  it('refuses HTML-free rules being bent: unknown fields, two order forms, repeated ids', () => {
    const base = page();
    const form = base.sections.find((s) => s.type === 'order_form')!;
    expect(
      landingContentSchema.safeParse({
        ...base,
        sections: [...base.sections, { ...form, id: 'zzzzzz' }],
      }).success,
    ).toBe(false);
    expect(
      landingContentSchema.safeParse({ ...base, sections: [...base.sections, form] }).success,
    ).toBe(false);
    expect(
      landingContentSchema.safeParse({
        ...base,
        sections: [{ ...base.sections[0], html: '<script>alert(1)</script>' }],
      }).success,
    ).toBe(false);
    expect(
      landingContentSchema.safeParse({
        ...base,
        sections: [{ id: 'abcdef', type: 'iframe', enabled: true, hideOn: 'none' }],
      }).success,
    ).toBe(false);
  });

  it('checks video links and countdown dates when saving', () => {
    const base = page();
    const video = {
      id: 'vid001',
      type: 'video',
      enabled: true,
      hideOn: 'none',
      title: '',
      url: 'https://vimeo.com/1',
    };
    const res = landingContentSchema.safeParse({ ...base, sections: [video] });
    expect(res.success).toBe(false);
    const countdown = landingContentSchema.parse({
      ...base,
      sections: [
        {
          id: 'cd0001',
          type: 'countdown',
          enabled: true,
          hideOn: 'none',
          heading: 'Offer ends in',
          endsAt: '2026-11-01T18:00:00+06:00',
          endedText: 'The offer has ended',
        },
      ],
    });
    expect((countdown.sections[0] as { endsAt: string }).endsAt).toBe('2026-11-01T12:00:00.000Z');
  });

  it('limits packages to six with distinct ids', () => {
    const pkg = (id: string) => ({
      id,
      label: 'One jar',
      quantity: 1,
      priceMinor: null,
      badge: '',
    });
    const base = page();
    const ok = { ...base.offer, packages: ['p00001', 'p00002'].map(pkg) };
    expect(landingContentSchema.safeParse({ ...base, offer: ok }).success).toBe(true);
    const many = { ...base.offer, packages: [1, 2, 3, 4, 5, 6, 7].map((n) => pkg(`p0000${n}`)) };
    expect(landingContentSchema.safeParse({ ...base, offer: many }).success).toBe(false);
    const twice = { ...base.offer, packages: [pkg('p00001'), pkg('p00001')] };
    expect(landingContentSchema.safeParse({ ...base, offer: twice }).success).toBe(false);
  });
});

describe('ready to publish', () => {
  it('needs an order form, an active product and complete sections', () => {
    const base = page();
    const noForm = { ...base, sections: base.sections.filter((s) => s.type !== 'order_form') };
    expect(publishProblems(noForm, ready).map((e) => e.path)).toEqual(['content.sections']);
    expect(
      publishProblems({ ...base, offer: { ...base.offer, productId: null } }, ready)[0]?.message,
    ).toBe('Choose the product this page sells');
    expect(
      publishProblems(base, { ...ready, product: { ...ready.product!, active: false } })[0]
        ?.message,
    ).toBe('Make the product active first');
    expect(publishProblems(base, { ...ready, product: null })[0]?.message).toBe(
      'This product no longer exists',
    );
    const emptyImage = {
      ...base,
      sections: [
        ...base.sections,
        {
          id: 'img001',
          type: 'image' as const,
          enabled: true,
          hideOn: 'none' as const,
          image: null,
          caption: '',
        },
      ],
    };
    expect(publishProblems(emptyImage, ready).map((e) => e.message)).toEqual(['Add the picture']);
    // A hidden (disabled) incomplete section does not block publishing.
    const hidden = {
      ...emptyImage,
      sections: emptyImage.sections.map((s) => (s.id === 'img001' ? { ...s, enabled: false } : s)),
    };
    expect(publishProblems(hidden, ready)).toEqual([]);
  });

  it('checks the add-on: active, existing option, not the same product', () => {
    const base = page();
    const addOn = { productId: ADDON, variantId: VARIANT, priceMinor: 9_900, label: 'Add a soap' };
    const withAddOn = { ...base, offer: { ...base.offer, addOn } };
    expect(publishProblems(withAddOn, ready)).toEqual([]);
    expect(
      publishProblems(withAddOn, { ...ready, addOn: { ...ready.addOn!, variantIds: [] } })[0]
        ?.message,
    ).toBe('This add-on option no longer exists');
    expect(publishProblems(withAddOn, { ...ready, addOn: null })[0]?.message).toBe(
      'The add-on product is missing or not active',
    );
    const same = { ...base, offer: { ...base.offer, addOn: { ...addOn, productId: PRODUCT.id } } };
    expect(publishProblems(same, ready).map((e) => e.message)).toContain(
      'Choose a different product for the add-on',
    );
  });

  it("holds back the template's sample words and sample reviews until they are replaced or hidden", () => {
    for (const lang of ['en', 'bn'] as const) {
      const full = landingContentSchema.parse(templateContent('full_offer', lang, PRODUCT));
      const where = (c: LandingContent) =>
        starterTextProblems(c).map((e) => c.sections[Number(e.path.split('.')[2])]!.type);
      expect(where(full)).toEqual(['benefits', 'reviews']);
      const problem = landingContentSchema.parse(
        templateContent('problem_solution', lang, PRODUCT),
      );
      expect(where(problem)).toEqual(['problem_solution', 'benefits', 'steps', 'reviews']);
      // The short template has no sample words at all.
      expect(starterTextProblems(templateContent('quick_order', lang, PRODUCT))).toEqual([]);

      // Hidden sections and the business's own words pass.
      const fixed: LandingContent = {
        ...full,
        sections: full.sections.map((s) =>
          s.type === 'reviews'
            ? { ...s, enabled: false }
            : s.type === 'benefits'
              ? { ...s, items: s.items.map((x, i) => ({ ...x, text: `Our own words ${i}` })) }
              : s,
        ),
      };
      expect(starterTextProblems(fixed)).toEqual([]);
    }
    const reviews = page().sections.find((s) => s.type === 'reviews')!;
    expect(starterTextProblems(page())[1]?.message).toBe(
      'Replace the sample reviews with real ones from your buyers, or hide this section',
    );
    // A sample name with a real review is still a made-up buyer.
    if (reviews.type === 'reviews')
      expect(
        starterTextProblems({
          ...page(),
          sections: [{ ...reviews, items: [{ ...reviews.items[0]!, text: 'Loved it' }] }],
        }),
      ).toHaveLength(1);
    // Both languages' words are known, and spaces around them do not hide them.
    expect(STARTER_TEXTS.has('Write the first step.')).toBe(true);
    expect(STARTER_TEXTS.has('প্রথম ধাপ লিখুন।')).toBe(true);
    const benefits = page().sections.find((s) => s.type === 'benefits')!;
    if (benefits.type === 'benefits')
      expect(
        starterTextProblems({
          ...page(),
          sections: [
            {
              ...benefits,
              items: [{ ...benefits.items[0]!, text: '  Write why the price is worth it.  ' }],
            },
          ],
        }),
      ).toHaveLength(1);
  });
});

describe('pictures', () => {
  it('lists every picture with where it sits, and fills in URLs without touching the rest', () => {
    const img = (n: number) => ({ fileId: FILE(n), url: '', alt: `pic ${n}` });
    const base = page();
    const content: LandingContent = {
      ...base,
      sections: [
        {
          id: 'hero01',
          type: 'hero',
          enabled: true,
          hideOn: 'none',
          heading: 'Hi',
          subheading: '',
          badge: '',
          buttonLabel: 'Order',
          image: img(1),
          showPrice: true,
        },
        {
          id: 'gal001',
          type: 'gallery',
          enabled: true,
          hideOn: 'none',
          title: '',
          source: 'custom',
          images: [img(2), img(3)],
        },
        {
          id: 'ba0001',
          type: 'before_after',
          enabled: true,
          hideOn: 'mobile',
          title: '',
          before: img(4),
          after: null,
          caption: '',
        },
        {
          id: 'rev001',
          type: 'reviews',
          enabled: false,
          hideOn: 'none',
          title: '',
          items: [{ name: 'Mina', text: 'Good', rating: 5, image: img(5) }],
        },
        {
          id: 'txt001',
          type: 'text',
          enabled: true,
          hideOn: 'none',
          heading: 'About',
          body: 'Plain words.',
        },
      ],
      seo: { ...base.seo, image: img(6) },
    };
    expect(contentImages(content)).toEqual([
      { fileId: FILE(1), path: 'content.sections.0.image.fileId' },
      { fileId: FILE(2), path: 'content.sections.1.images.0.fileId' },
      { fileId: FILE(3), path: 'content.sections.1.images.1.fileId' },
      { fileId: FILE(4), path: 'content.sections.2.before.fileId' },
      { fileId: FILE(5), path: 'content.sections.3.items.0.image.fileId' },
      { fileId: FILE(6), path: 'content.seo.image.fileId' },
    ]);
    const filled = withImageUrls(content, (id) => `https://cdn.test/${id}.png`);
    expect(contentImages(filled)).toEqual(contentImages(content));
    expect((filled.sections[0] as { image: { url: string; alt: string } }).image).toEqual({
      fileId: FILE(1),
      url: `https://cdn.test/${FILE(1)}.png`,
      alt: 'pic 1',
    });
    expect(filled.sections[4]).toBe(content.sections[4]);
    expect(filled.seo.image?.url).toBe(`https://cdn.test/${FILE(6)}.png`);
  });
});

describe('word check input', () => {
  it('collects every text shoppers read, with where it is', () => {
    const base = page();
    const texts = contentTexts('Aloe offer', {
      ...base,
      offer: {
        ...base.offer,
        packages: [
          { id: 'p00001', label: 'Two jars', quantity: 2, priceMinor: 90_000, badge: 'Best value' },
        ],
      },
    });
    expect(texts[0]).toEqual({ where: 'name', label: 'Page name', text: 'Aloe offer' });
    expect(texts.some((t) => t.where.startsWith('section:'))).toBe(true);
    expect(texts.find((t) => t.where === 'offer')?.text).toContain('Two jars');
  });
});

describe('package prices', () => {
  it('charges the regular price when the package has none', () => {
    expect(packageCharge(45_000, 2, null)).toEqual({
      unitPriceMinor: 45_000,
      discountMinor: 0,
      totalMinor: 90_000,
    });
  });

  it('records a cheaper package as a discount on the regular price', () => {
    expect(packageCharge(45_000, 2, 80_000)).toEqual({
      unitPriceMinor: 45_000,
      discountMinor: 10_000,
      totalMinor: 80_000,
    });
  });

  it('raises the unit price when the package costs more, and keeps the exact total', () => {
    // The product got cheaper after the page was made: 3 for 1,000 while one costs 300.
    const c = packageCharge(30_000, 3, 100_000);
    expect(c.totalMinor).toBe(100_000);
    expect(c.unitPriceMinor * 3 - c.discountMinor).toBe(100_000);
    expect(c.discountMinor).toBeGreaterThanOrEqual(0);
    expect(c.discountMinor).toBeLessThan(3);
  });
});

describe('days', () => {
  it("counts days in the business's time zone", () => {
    // 20:30 UTC on the 27th is already the 28th in Dhaka (UTC+6).
    const at = new Date('2026-10-27T20:30:00Z');
    expect(dayKey(at, 'Asia/Dhaka')).toBe('2026-10-28');
    expect(dayKey(at, 'UTC')).toBe('2026-10-27');
    expect(dayKey(at, 'Not/AZone')).toBe('2026-10-27');
  });
});
