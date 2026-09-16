/**
 * Text primitives the correctness of this system rests on.
 *
 * No `server-only` here: these are pure functions with no secrets, and the
 * review UI needs the same character counter the format check uses. Two
 * implementations of "how long is this X post" is how a post passes review and
 * is then rejected by the platform.
 */

import {
  CHANNEL_LIMITS,
  CHARS_PER_TOKEN,
  TRACKING_PARAMS,
} from "./constants";

// ─── Sentence segmentation ──────────────────────────────────────────────────

/**
 * DESIGN.md §10 and Conventions: `Intl.Segmenter`, never a split on ".".
 * The claim map depends on this, and a hand-rolled split would break on
 * "2.5%" and "Inc." and corrupt the map silently — the worst kind of bug this
 * system can have.
 */
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

export interface Sentence {
  index: number;
  text: string;
  /** Offset into the string that was segmented. */
  start: number;
  end: number;
}

export function segmentSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let index = 0;

  for (const segment of segmenter.segment(text)) {
    const trimmed = segment.segment.trim();
    if (trimmed.length === 0) continue;
    out.push({
      index: index++,
      text: trimmed,
      start: segment.index,
      end: segment.index + segment.segment.length,
    });
  }

  return out;
}

/** Word count on prose, ignoring markdown punctuation. */
export function countWords(markdown: string): number {
  const prose = stripMarkdown(markdown);
  const matches = prose.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu);
  return matches?.length ?? 0;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Markdown ───────────────────────────────────────────────────────────────

/** Prose only: headings, emphasis, links, code and images removed. */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/\|/g, " ")
    .trim();
}

export interface ParsedHeading {
  level: 1 | 2 | 3;
  text: string;
  line: number;
}

/** Heading tree for the SEO structure checks (§10). Fenced code is skipped. */
export function parseHeadings(markdown: string): ParsedHeading[] {
  const out: ParsedHeading[] = [];
  let inFence = false;

  markdown.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return;

    const level = match[1]!.length;
    if (level > 3) return;
    out.push({ level: level as 1 | 2 | 3, text: match[2]!.trim(), line: i });
  });

  return out;
}

/** Paragraphs, for the 2–3 sentence rule. Headings and lists are not prose. */
export function parseParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(
      (block) =>
        block.length > 0 &&
        !/^#{1,6}\s/.test(block) &&
        !/^\s*[-*+]\s/.test(block) &&
        !/^\s*\d+\.\s/.test(block) &&
        !/^\s*>/.test(block) &&
        !/^```/.test(block) &&
        !/^\s*\|/.test(block),
    );
}

export function extractMarkdownLinks(markdown: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  const pattern = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    out.push({ text: match[1]!, url: match[2]! });
  }
  return out;
}

// ─── Keyword matching ───────────────────────────────────────────────────────

/**
 * Case-insensitive and lightly stemmed (§10). "content marketing" matches
 * "Content Marketing" and "content marketers", because an SEO check that a
 * plural defeats is a check that generates false failures and gets ignored.
 */
export function containsKeyword(haystack: string, keyword: string): boolean {
  if (!keyword.trim()) return false;

  const words = keyword
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(stemLoosely);

  if (words.length === 0) return false;

  const pattern = new RegExp(
    words.map((w) => `${escapeRegex(w)}\\w*`).join("\\W+"),
    "i",
  );
  return pattern.test(haystack.toLowerCase());
}

/** Deliberately crude: drops only the endings that break an exact match. */
function stemLoosely(word: string): string {
  if (word.length <= 4) return word;
  return word
    .replace(/(ies)$/, "y")
    .replace(/(ing|ers|ed|es|s)$/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function firstNWords(text: string, n: number): string {
  return stripMarkdown(text).split(/\s+/).slice(0, n).join(" ");
}

// ─── X character counting ───────────────────────────────────────────────────

/**
 * DESIGN.md §12.1 and Conventions: any URL weighs 23 characters regardless of
 * its real length, and most emoji and CJK characters weigh 2.
 *
 * `body.length` in JavaScript will pass posts the API then rejects, so this is
 * a small tested function rather than a property access. The tests in
 * `text.test.ts` include the case the spec calls out: a post that goes over
 * 280 only once the link is counted.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']+|(?:^|\s)(?:www\.)[^\s<>"']+/gi;

export function countXCharacters(text: string): number {
  let total = 0;
  let lastIndex = 0;

  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = URL_PATTERN.exec(text)) !== null) {
    // A leading space captured by the www. branch belongs to the surrounding
    // text, not to the URL.
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const urlStart = match.index + leading;

    total += weighRange(text.slice(lastIndex, urlStart));
    total += CHANNEL_LIMITS.x.urlWeight;
    lastIndex = match.index + raw.length;
  }

  total += weighRange(text.slice(lastIndex));
  return total;
}

/**
 * Cuts an X post down to the weighted limit, at a sentence boundary.
 *
 * The last resort after the model has been asked twice and still overshot.
 * Length is the one format rule that can be satisfied exactly in code, so
 * handing a 326-character post to a person with "cut at least 46 characters"
 * is asking them to do arithmetic the machine can do perfectly.
 *
 * Trims whole sentences from the end, because cutting mid-sentence leaves a
 * fragment that reads as a bug. If even the first sentence does not fit, falls
 * back to a word boundary with an ellipsis. Hashtags are never cut — they are
 * appended after the trim, since a post that loses its tags loses its reach.
 */
export function trimXPost(body: string, hashtags: string[] = []): string {
  const limit = CHANNEL_LIMITS.x.maxChars;

  // Hashtags are reserved out of the budget up front, with a space before each.
  const tagSuffix = hashtags.length > 0 ? " " + hashtags.join(" ") : "";
  const bodyWithoutTags = stripTrailingTags(body, hashtags);
  const budget = limit - countXCharacters(tagSuffix);

  if (countXCharacters(bodyWithoutTags) <= budget) {
    // Already fits: the overflow was the tags being counted twice.
    return (bodyWithoutTags.trimEnd() + tagSuffix).trim();
  }

  const sentences = bodyWithoutTags.match(/[^.!?\n]+[.!?]*\n*/g) ?? [bodyWithoutTags];

  let kept = "";
  for (const sentence of sentences) {
    if (countXCharacters(kept + sentence) > budget) break;
    kept += sentence;
  }

  if (kept.trim().length === 0) {
    // Not even one sentence fits. Cut on a word boundary and signal the cut.
    const words = bodyWithoutTags.split(/\s+/);
    for (const word of words) {
      const next = kept ? `${kept} ${word}` : word;
      if (countXCharacters(`${next}…`) > budget) break;
      kept = next;
    }
    kept = kept ? `${kept}…` : bodyWithoutTags.slice(0, budget);
  }

  return (kept.trimEnd() + tagSuffix).trim();
}

/** Removes hashtags already present at the end, so they are not duplicated. */
function stripTrailingTags(body: string, hashtags: string[]): string {
  let out = body.trimEnd();
  for (const tag of [...hashtags].reverse()) {
    if (out.endsWith(tag)) out = out.slice(0, -tag.length).trimEnd();
  }
  return out;
}

/**
 * Twitter's weighted counting: characters outside the Latin/General
 * Punctuation ranges count 2. Iterating code points (not UTF-16 units) is what
 * makes an emoji weigh 2 rather than its surrogate pair weighing 2 each.
 */
function weighRange(text: string): number {
  let total = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const isLightWeight =
      (cp >= 0x0000 && cp <= 0x10ff) ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    total += isLightWeight ? 1 : CHANNEL_LIMITS.x.wideCharWeight;
  }
  return total;
}

export function countEmoji(text: string): number {
  const matches = text.match(/\p{Extended_Pictographic}/gu);
  return matches?.length ?? 0;
}

// ─── URL canonicalisation ───────────────────────────────────────────────────

/**
 * DESIGN.md §5.4: lowercase host, strip www., strip fragment, strip tracking
 * params, collapse trailing slash. Two links to the same article do not become
 * two sources, and the same article across two requests still re-uses the
 * Firecrawl cache.
 */
export function canonicaliseUrl(input: string): string {
  const url = new URL(input.trim());

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";

  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  // Any remaining utm_* variant, including ones not in the fixed list.
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  // Default ports carry no meaning and would split one article into two rows.
  if ((url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  return url.toString();
}

export function isValidUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Registrable domain, for the `redirected_offsite` check (§7.3). Deliberately
 * simple: a public-suffix list is not worth the dependency when the only
 * consumer flags a redirect for a human to look at.
 */
export function registrableDomain(input: string): string {
  try {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length <= 2) return host;

    const twoLevelTlds = ["co.uk", "com.ng", "co.za", "com.au", "co.ke", "org.uk", "ac.uk"];
    const lastTwo = parts.slice(-2).join(".");
    return twoLevelTlds.includes(lastTwo)
      ? parts.slice(-3).join(".")
      : parts.slice(-2).join(".");
  } catch {
    return "";
  }
}

export function siteNameFromUrl(input: string): string {
  try {
    return new URL(input).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ─── Slugs ──────────────────────────────────────────────────────────────────

/** Permalink segment, stable once assigned (§10.1). */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/-$/, "");
}

// ─── E.164 ──────────────────────────────────────────────────────────────────

/**
 * Phone numbers are stored and validated as E.164, rejected at import with the
 * row number rather than at send time (Conventions, §15.3).
 */
export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value.trim());
}

export function normaliseE164(value: string): string | null {
  const cleaned = value.trim().replace(/[\s()\-.]/g, "");
  const candidate = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return isValidE164(candidate) ? candidate : null;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/**
 * DESIGN.md Conventions: "Print the data before reasoning about it. When a
 * parse, a keyword match or a character count behaves impossibly, dump the raw
 * bytes — an invisible character on a string cost hours once already."
 *
 * Used wherever a parse or a count behaves impossibly.
 */
export function describeBytes(value: string, limit = 120): string {
  return [...value]
    .slice(0, limit)
    .map((char) => {
      const cp = char.codePointAt(0)!;
      if (char === "\n") return "\\n";
      if (char === "\t") return "\\t";
      if (char === "\r") return "\\r";
      if (cp < 0x20 || cp === 0x7f) return `\\x${cp.toString(16).padStart(2, "0")}`;
      // The invisible ones that cost hours: zero-width, BOM, nbsp.
      if (cp === 0x00a0) return "[NBSP]";
      if (cp === 0xfeff) return "[BOM]";
      if (cp >= 0x200b && cp <= 0x200f) return `[U+${cp.toString(16).toUpperCase()}]`;
      return char;
    })
    .join("");
}
