/**
 * robots.txt as RFC 9309 reads it (ADR 0024): the group for our product token, or `*`;
 * the longest matching rule wins and `Allow` wins a tie; `*` matches anything and a final `$`
 * anchors the end. Also collects `Sitemap:` lines and a `Crawl-delay` (not in the RFC, but
 * widely used).
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  rules: RobotsRule[];
  sitemaps: string[];
  /** Seconds, when the group asks for one. */
  crawlDelay: number | null;
}

/** robots.txt files are read up to this size (the RFC's minimum is 500 KiB). */
export const ROBOTS_MAX_BYTES = 512 * 1024;

export const ALLOW_ALL: Robots = { rules: [], sitemaps: [], crawlDelay: null };

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay: number | null;
}

/** Parses a robots.txt for the crawler named `token` (matched case-insensitively). */
export function parseRobots(text: string, token: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  // A group starts at a user-agent line that follows a rule line (or the start).
  let lastWasAgent = false;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  const name = token.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a === name || name.startsWith(a + '/')));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return {
    // Groups for the same agent are merged (RFC 9309, 2.2.1).
    rules: chosen.flatMap((g) => g.rules),
    sitemaps,
    crawlDelay: chosen.reduce<number | null>(
      (d, g) => (g.crawlDelay === null ? d : Math.max(d ?? 0, g.crawlDelay)),
      null,
    ),
  };
}

/** Percent-encodes what needs it, so `/a%2fb` and `/a/b` stay different but `/é` matches. */
function normalizePath(path: string): string {
  return path
    .replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase())
    .replace(/[^\x21-\x7e]/g, (ch) => encodeURIComponent(ch));
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = normalizePath(anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

const compiled = new WeakMap<RobotsRule, RegExp>();

/** Whether the path (with its query) may be crawled. `/robots.txt` itself is always allowed. */
export function isAllowed(robots: Robots, pathAndQuery: string): boolean {
  if (pathAndQuery === '/robots.txt') return true;
  const path = normalizePath(pathAndQuery || '/');
  let best: RobotsRule | null = null;
  for (const rule of robots.rules) {
    let re = compiled.get(rule);
    if (!re) {
      re = compile(rule.pattern);
      compiled.set(rule, re);
    }
    if (!re.test(path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    )
      best = rule;
  }
  return best ? best.allow : true;
}
