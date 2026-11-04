import {
  Hind_Siliguri,
  Inter,
  Noto_Sans_Bengali,
  Noto_Serif_Bengali,
  Nunito,
  Playfair_Display,
} from 'next/font/google';

// Every store picks one of three type pairs; a font file downloads only when a page uses it.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
  preload: false,
});
const bnSans = Noto_Sans_Bengali({
  subsets: ['bengali'],
  variable: '--font-bn-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
  preload: false,
});
const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
  preload: false,
});
const bnSerif = Noto_Serif_Bengali({
  subsets: ['bengali'],
  variable: '--font-bn-serif',
  display: 'swap',
  weight: ['400', '600', '700'],
  preload: false,
});
const nunito = Nunito({
  subsets: ['latin'],
  variable: '--font-nunito',
  display: 'swap',
  preload: false,
});
const hind = Hind_Siliguri({
  subsets: ['bengali'],
  variable: '--font-bn-hind',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
  preload: false,
});
export const fontVars = [inter, bnSans, playfair, bnSerif, nunito, hind]
  .map((f) => f.variable)
  .join(' ');
