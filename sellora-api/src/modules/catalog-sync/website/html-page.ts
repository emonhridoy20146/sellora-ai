import { Parser } from 'htmlparser2';

/**
 * What the crawler needs from one HTML page (ADR 0024), read in one pass with a tolerant
 * tokenizer: title and description, canonical address, robots directives, links,
 * JSON-LD blocks, OpenGraph and product meta tags, the ownership token, and the page's main
 * text as blocks (headings, paragraphs and list items on their own lines).
 */

export interface HtmlPage {
  title: string;
  description: string;
  lang: string | null;
  canonical: string | null;
  /** `<base href>`, for resolving links. */
  base: string | null;
  noindex: boolean;
  nofollow: boolean;
  /** Absolute or relative hrefs of followable links, as written. */
  links: string[];
  /** The raw text of each `application/ld+json` script. */
  jsonLd: string[];
  /** `property` / `name` → content of meta tags (first wins), lower-cased keys. */
  meta: Record<string, string>;
  /** Content of every `sellora-site-verification` meta tag. */
  verification: string[];
  /** Main text, one block per line. */
  text: string;
  words: number;
  /** Scripts that are not JSON-LD: a page that is mostly scripts is built in the browser. */
  scripts: number;
}

/** Text kept per page. */
export const PAGE_TEXT_MAX = 20_000;
/** Links read per page. */
const LINKS_MAX = 2_000;
const JSON_LD_MAX = 20;

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
  'canvas',
  'select',
  'textarea',
  'button',
  'head',
]);
/** Site furniture left out of the text when the page has no <main>. */
const CHROME = new Set(['header', 'nav', 'footer', 'aside', 'form', 'dialog', 'menu']);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'aside',
  'nav',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'tr',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'address',
  'dl',
  'dt',
  'dd',
  'hr',
  'br',
  'details',
  'summary',
]);

interface Frame {
  name: string;
  skip: boolean;
  chrome: boolean;
  main: boolean;
  hidden: boolean;
}

export const countWords = (text: string): number =>
  text.split(/[\s\u00a0।,.;:!?()[\]{}"'“”‘’/\\|-]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function tidy(parts: string[]): string {
  return parts
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v \u00a0\u200b]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function directives(content: string): { noindex: boolean; nofollow: boolean } {
  const d = content.toLowerCase().split(/[\s,]+/);
  return {
    noindex: d.includes('noindex') || d.includes('none'),
    nofollow: d.includes('nofollow') || d.includes('none'),
  };
}

/** Reads a page. `robotsHeader` is the response's X-Robots-Tag, when it had one. */
export function parseHtmlPage(html: string, robotsHeader?: string): HtmlPage {
  const page: HtmlPage = {
    title: '',
    description: '',
    lang: null,
    canonical: null,
    base: null,
    noindex: false,
    nofollow: false,
    links: [],
    jsonLd: [],
    meta: {},
    verification: [],
    text: '',
    words: 0,
    scripts: 0,
  };
  if (robotsHeader) {
    // "googlebot: noindex" applies to another crawler; plain directives apply to all.
    for (const part of robotsHeader.split(/,(?=\s*[a-z-]+\s*:)/i)) {
      const named = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(part);
      if (named && !['sellorabot', 'all'].includes(named[1]!.toLowerCase())) continue;
      const d = directives(named ? named[2]! : part);
      page.noindex ||= d.noindex;
      page.nofollow ||= d.nofollow;
    }
  }
  const stack: Frame[] = [];
  const mainParts: string[] = [];
  const bodyParts: string[] = [];
  let title = '';
  let inTitle = false;
  let jsonLd: string | null = null;
  let sawMain = false;

  const flags = () => {
    const top = stack[stack.length - 1];
    return top ?? { name: '', skip: false, chrome: false, main: false, hidden: false };
  };
  const push = (text: string) => {
    const f = flags();
    if (f.skip || f.hidden) return;
    if (f.main) mainParts.push(text);
    if (!f.chrome) bodyParts.push(text);
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const parent = flags();
        const lower = name.toLowerCase();
        const role = (attrs.role ?? '').toLowerCase();
        const isMain = lower === 'main' || role === 'main';
        if (isMain) sawMain = true;
        const hidden =
          'hidden' in attrs ||
          attrs['aria-hidden'] === 'true' ||
          /display\s*:\s*none/i.test(attrs.style ?? '');
        stack.push({
          name: lower,
          skip: parent.skip || SKIP.has(lower),
          chrome:
            parent.chrome ||
            (!parent.main && (CHROME.has(lower) || role === 'navigation' || role === 'banner')),
          main: parent.main || isMain,
          hidden: parent.hidden || hidden,
        });
        if (BLOCK.has(lower)) push(lower === 'li' ? '\n• ' : '\n');
        if (lower === 'td' || lower === 'th') push(' ');
        switch (lower) {
          case 'html':
            if (attrs.lang) page.lang = attrs.lang.trim().slice(0, 20) || null;
            break;
          case 'title':
            if (!parent.skip || parent.name === 'head') inTitle = true;
            break;
          case 'base':
            if (attrs.href && !page.base) page.base = attrs.href.trim();
            break;
          case 'link': {
            const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
            if (rel.includes('canonical') && attrs.href && !page.canonical)
              page.canonical = attrs.href.trim();
            break;
          }
          case 'meta': {
            const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').trim().toLowerCase();
            const content = (attrs.content ?? '').trim();
            if (!key) break;
            if (key === 'sellora-site-verification') {
              if (content) page.verification.push(content);
              break;
            }
            if (key === 'robots' || key === 'sellorabot') {
              const d = directives(content);
              page.noindex ||= d.noindex;
              page.nofollow ||= d.nofollow;
              break;
            }
            if (!(key in page.meta) && content) page.meta[key] = content.slice(0, 2000);
            break;
          }
          case 'a':
          case 'area': {
            const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
            if (attrs.href && !rel.includes('nofollow') && page.links.length < LINKS_MAX)
              page.links.push(attrs.href.trim());
            break;
          }
          case 'script': {
            const type = (attrs.type ?? '').trim().toLowerCase();
            if (type === 'application/ld+json') jsonLd = '';
            else if (!type || type.includes('javascript') || type === 'module') page.scripts += 1;
            break;
          }
        }
      },
      ontext(text) {
        if (inTitle) {
          title += text;
          return;
        }
        if (jsonLd !== null) {
          jsonLd += text;
          return;
        }
        push(text);
      },
      onclosetag(name) {
        const lower = name.toLowerCase();
        if (lower === 'title') inTitle = false;
        if (lower === 'script' && jsonLd !== null) {
          if (page.jsonLd.length < JSON_LD_MAX) page.jsonLd.push(jsonLd);
          jsonLd = null;
        }
        if (BLOCK.has(lower)) push('\n');
        for (let i = stack.length - 1; i >= 0; i--)
          if (stack[i]!.name === lower) {
            stack.length = i;
            break;
          }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  page.title = (title || page.meta['og:title'] || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  page.description = (page.meta['description'] ?? page.meta['og:description'] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
  const main = sawMain ? tidy(mainParts) : '';
  const text = (main && countWords(main) >= 20 ? main : tidy(bodyParts)).slice(0, PAGE_TEXT_MAX);
  page.text = text;
  page.words = countWords(text);
  return page;
}
