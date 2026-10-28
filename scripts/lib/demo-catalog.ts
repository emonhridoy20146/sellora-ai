import type { PatternKind } from './pattern-png.js';

/** The demo online shop's catalog: Bangladeshi clothing and handicrafts. */
export interface DemoProduct {
  name: string;
  category: string;
  description: string;
  tags: string[];
  pattern: { kind: PatternKind; colors: [string, string, string] };
  options?: { name: string; values: string[] }[];
  variants: {
    optionValues?: string[];
    priceMinor: number;
    compareAtPriceMinor?: number;
    stock: number;
  }[];
}

export const DEMO_CATEGORIES = ['Sarees', 'Panjabi', 'Kurti', 'Home', 'Accessories'];

export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    name: 'Dhakai Jamdani Saree',
    category: 'Sarees',
    description:
      'Hand-woven in Rupganj on a traditional pit loom. Fine cotton with woven buti all over and a contrast paar.\n\nComes with an unstitched blouse piece. Dry clean only.',
    tags: ['jamdani', 'saree', 'handloom'],
    pattern: { kind: 'saree', colors: ['#8c1c2c', '#d4a017', '#f3d58a'] },
    options: [{ name: 'Colour', values: ['Maroon', 'Indigo'] }],
    variants: [
      { optionValues: ['Maroon'], priceMinor: 650_000, compareAtPriceMinor: 720_000, stock: 4 },
      { optionValues: ['Indigo'], priceMinor: 650_000, stock: 2 },
    ],
  },
  {
    name: 'Tangail Cotton Saree',
    category: 'Sarees',
    description: 'Soft, light cotton for every day. Woven in Tangail with a thin zari border.',
    tags: ['tangail', 'cotton', 'saree'],
    pattern: { kind: 'saree', colors: ['#2f6f5e', '#e9c46a', '#fefae0'] },
    variants: [{ priceMinor: 220_000, stock: 12 }],
  },
  {
    name: 'Rajshahi Silk Saree',
    category: 'Sarees',
    description:
      'Pure Rajshahi silk with a rich, soft drape. A festive saree for Eid and weddings.',
    tags: ['silk', 'rajshahi', 'saree'],
    pattern: { kind: 'diagonal', colors: ['#5a189a', '#e0aaff', '#ffd166'] },
    variants: [{ priceMinor: 890_000, compareAtPriceMinor: 980_000, stock: 3 }],
  },
  {
    name: 'Cotton Panjabi',
    category: 'Panjabi',
    description: 'Breathable cotton panjabi with a mandarin collar. Regular fit.',
    tags: ['panjabi', 'cotton', 'men'],
    pattern: { kind: 'weave', colors: ['#f1ece2', '#c9b79c', '#8d775f'] },
    options: [{ name: 'Size', values: ['M', 'L', 'XL'] }],
    variants: [
      { optionValues: ['M'], priceMinor: 185_000, stock: 8 },
      { optionValues: ['L'], priceMinor: 185_000, stock: 10 },
      { optionValues: ['XL'], priceMinor: 195_000, stock: 0 },
    ],
  },
  {
    name: 'Embroidered Eid Panjabi',
    category: 'Panjabi',
    description: 'Fine cotton blend with hand embroidery on the placket and cuffs.',
    tags: ['panjabi', 'eid', 'embroidered'],
    pattern: { kind: 'dots', colors: ['#1d3557', '#a8dadc', '#f1faee'] },
    options: [{ name: 'Size', values: ['M', 'L', 'XL'] }],
    variants: [
      { optionValues: ['M'], priceMinor: 265_000, stock: 5 },
      { optionValues: ['L'], priceMinor: 265_000, stock: 2 },
      { optionValues: ['XL'], priceMinor: 275_000, stock: 4 },
    ],
  },
  {
    name: 'Block-print Kurti',
    category: 'Kurti',
    description: 'Hand block-printed cotton kurti with three-quarter sleeves.',
    tags: ['kurti', 'block print', 'women'],
    pattern: { kind: 'diagonal', colors: ['#fefae0', '#bc6c25', '#283618'] },
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    variants: [
      { optionValues: ['S'], priceMinor: 145_000, stock: 6 },
      { optionValues: ['M'], priceMinor: 145_000, stock: 9 },
      { optionValues: ['L'], priceMinor: 145_000, stock: 5 },
    ],
  },
  {
    name: 'Khadi Kurti',
    category: 'Kurti',
    description: 'Hand-spun khadi from Cumilla. Gets softer with every wash.',
    tags: ['khadi', 'kurti', 'cumilla'],
    pattern: { kind: 'weave', colors: ['#e76f51', '#f4a261', '#264653'] },
    variants: [{ priceMinor: 125_000, compareAtPriceMinor: 150_000, stock: 15 }],
  },
  {
    name: 'Nakshi Kantha Throw',
    category: 'Home',
    description:
      'Layers of soft cotton stitched by hand by women artisans in Jessore. Each one is different.',
    tags: ['nakshi kantha', 'throw', 'handmade'],
    pattern: { kind: 'kantha', colors: ['#fdf0d5', '#c1121f', '#003049'] },
    variants: [{ priceMinor: 320_000, stock: 3 }],
  },
  {
    name: 'Nakshi Cushion Cover',
    category: 'Home',
    description: 'Kantha-stitched cushion cover, 16 by 16 inches. Zip closure.',
    tags: ['cushion', 'kantha', 'home'],
    pattern: { kind: 'kantha', colors: ['#283618', '#dda15e', '#fefae0'] },
    variants: [{ priceMinor: 75_000, stock: 20 }],
  },
  {
    name: 'Handloom Gamchha',
    category: 'Accessories',
    description: 'The classic checked cotton gamchha. Quick to dry, softer every wash.',
    tags: ['gamchha', 'cotton', 'checks'],
    pattern: { kind: 'checks', colors: ['#c1121f', '#2a9d8f', '#fefae0'] },
    variants: [{ priceMinor: 28_000, stock: 40 }],
  },
  {
    name: 'Jute Tote Bag',
    category: 'Accessories',
    description: 'Sturdy golden jute with cotton handles. Fits a laptop.',
    tags: ['jute', 'bag', 'eco'],
    pattern: { kind: 'weave', colors: ['#c8a165', '#8a6a3b', '#4a3a22'] },
    variants: [{ priceMinor: 65_000, stock: 18 }],
  },
  {
    name: 'Terracotta Earrings',
    category: 'Accessories',
    description: 'Light, hand-painted terracotta earrings from Bogura.',
    tags: ['earrings', 'terracotta', 'jewellery'],
    pattern: { kind: 'dots', colors: ['#9c3d1c', '#f2cc8f', '#3d405b'] },
    variants: [{ priceMinor: 35_000, stock: 25 }],
  },
];
