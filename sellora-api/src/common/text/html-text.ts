/**
 * HTML from other systems (a Shopify description, a web page) as plain text: block elements
 * become line breaks, list items get a bullet, scripts and styles are dropped, character
 * references are decoded, and whitespace is tidied. Not a sanitiser for showing HTML: the
 * result is text and is shown as text.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  rupee: '₹',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

const BLOCK =
  /^(p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|table|tr|blockquote|pre|figure|figcaption|address|dl|dt|dd|hr|form|fieldset)$/i;

export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_tag, name: string) =>
      BLOCK.test(name)
        ? '\n'
        : name.toLowerCase() === 'td' || name.toLowerCase() === 'th'
          ? ' '
          : '',
    )
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v \u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
