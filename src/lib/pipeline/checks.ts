/**
 * Computed checks. No model, no opinion.
 *
 * DESIGN.md §2.6: "the parts that can be measured should never be opinions".
 * Everything here is deterministic and runs before the judge sees anything, so
 * a model that returns `pass` while one of these is failing is overruled
 * (§11.2).
 *
 * The rules come from `assets/seo-best-practices.md` and
 * `assets/channel-formatting-rules.md`, which are requirements, not
 * suggestions (CLAUDE.md).
 */

import {
  ARTICLE_MAX_WORDS,
  ARTICLE_MIN_WORDS,
  CHANNEL_LIMITS,
  KEYWORD_FIRST_N_WORDS,
  MAX_ARTICLE_LINKS,
  MAX_SENTENCES_PER_PARAGRAPH,
  META_DESCRIPTION_MAX_CHARS,
  MIN_ARTICLE_LINKS,
} from "@/lib/constants";
import {
  containsKeyword,
  countEmoji,
  countWords,
  countXCharacters,
  extractMarkdownLinks,
  firstNWords,
  parseHeadings,
  parseParagraphs,
  segmentSentences,
  stripMarkdown,
} from "@/lib/text";
import type { FormatCheckResult, OutlineSection } from "@/lib/db/types";

export interface Check {
  name: string;
  passed: boolean;
  /** Always names the ACTUAL measured value, so a retry prompt can cite it. */
  detail: string;
}

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

// ─── SEO checks (§10) ───────────────────────────────────────────────────────

export interface SeoCheckInput {
  title: string;
  metaDescription: string | null;
  bodyMd: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  outline: OutlineSection[];
  /** Real URLs of the sources selected for this request. */
  allowedUrls: string[];
}

export interface SeoCheckResult {
  passed: boolean;
  checks: Check[];
  keywordInTitle: boolean;
  keywordInFirst100: boolean;
  exactlyOneH1: boolean;
  hasH2s: boolean;
  linkCount: number;
  linksResolve: boolean;
  longParagraphs: number;
  wordCount: number;
  missingSections: string[];
}

export function runSeoChecks(input: SeoCheckInput): SeoCheckResult {
  const { title, metaDescription, bodyMd, primaryKeyword, outline, allowedUrls } = input;

  const headings = parseHeadings(bodyMd);
  const h1s = headings.filter((h) => h.level === 1);
  const h2s = headings.filter((h) => h.level === 2);
  const paragraphs = parseParagraphs(bodyMd);
  /**
   * Links exist as MARKERS at evaluation time, not as markdown.
   *
   * The model is forbidden from writing a URL (rule 3): it writes
   * `((link: anchor | E12))` and the server substitutes the real URL at
   * publish. Counting only `[text](url)` therefore reported zero links on an
   * article that had three, and the SEO check failed a draft that could never
   * satisfy it, because satisfying it would have meant breaking rule 3.
   *
   * One request spent every revision round on this, each rewrite dropping more
   * of the article while the count stayed at zero.
   */
  const markerLinks = [...bodyMd.matchAll(/\(\(link:\s*([^|)]+)\|\s*(E\d+)\s*\)\)/g)].map(
    (m) => ({ text: m[1]!.trim(), url: `marker:${m[2]}` }),
  );
  const links = [...extractMarkdownLinks(bodyMd), ...markerLinks];
  const wordCount = countWords(bodyMd);

  const keywordInTitle = containsKeyword(title, primaryKeyword);
  const keywordInFirst100 = containsKeyword(
    firstNWords(bodyMd, KEYWORD_FIRST_N_WORDS),
    primaryKeyword,
  );

  // Every link must resolve to a selected source URL. The model never writes a
  // URL (rule 3), so a link outside this set means substitution failed —
  // which is a bug worth surfacing, not a style note.
  const allowed = new Set(allowedUrls);
  // A `marker:` link resolves by construction: the server substitutes the URL
  // from the excerpt's own source, so there is no URL here to be wrong yet.
  // Marker integrity is checked separately and is a hard failure there.
  const unresolved = links.filter(
    (l) => !allowed.has(l.url) && !l.url.startsWith("/") && !l.url.startsWith("marker:"),
  );
  const linksResolve = unresolved.length === 0;

  const longParagraphs = paragraphs.filter(
    (p) => segmentSentences(stripMarkdown(p)).length > MAX_SENTENCES_PER_PARAGRAPH,
  ).length;

  // Completeness: every outline section present (§11.1). A missing section is
  // a Completeness failure, not a shorter article (§17).
  const headingText = headings.map((h) => h.text.toLowerCase());
  const missingSections = outline
    .filter((section) => {
      const target = section.heading.toLowerCase();
      return !headingText.some(
        (h) => h.includes(target) || target.includes(h) || overlapRatio(h, target) > 0.6,
      );
    })
    .map((s) => s.heading);

  const checks: Check[] = [
    check(
      "Primary keyword in title",
      keywordInTitle,
      keywordInTitle
        ? `"${primaryKeyword}" appears in the title.`
        : `The title "${title}" does not contain "${primaryKeyword}".`,
    ),
    check(
      "Primary keyword in first 100 words",
      keywordInFirst100,
      keywordInFirst100
        ? `"${primaryKeyword}" appears early in the body.`
        : `"${primaryKeyword}" does not appear in the first ${KEYWORD_FIRST_N_WORDS} words.`,
    ),
    check(
      "Exactly one H1",
      h1s.length === 1,
      `Found ${h1s.length} H1 heading${h1s.length === 1 ? "" : "s"}.`,
    ),
    check(
      "H2 sections present",
      h2s.length >= 2,
      `Found ${h2s.length} H2 section${h2s.length === 1 ? "" : "s"}.`,
    ),
    check(
      "2 to 3 relevant links",
      links.length >= MIN_ARTICLE_LINKS && links.length <= MAX_ARTICLE_LINKS,
      `Found ${links.length} link${links.length === 1 ? "" : "s"}; the rule is ${MIN_ARTICLE_LINKS} to ${MAX_ARTICLE_LINKS}.`,
    ),
    check(
      "Every link resolves to a selected source",
      linksResolve,
      linksResolve
        ? "All links point at sources selected for this request."
        : `${unresolved.length} link(s) point somewhere that is not a selected source: ${unresolved
            .map((l) => l.url)
            .join(", ")}`,
    ),
    check(
      "Short paragraphs",
      longParagraphs === 0,
      longParagraphs === 0
        ? `All ${paragraphs.length} paragraphs are ${MAX_SENTENCES_PER_PARAGRAPH} sentences or fewer.`
        : `${longParagraphs} of ${paragraphs.length} paragraphs run longer than ${MAX_SENTENCES_PER_PARAGRAPH} sentences.`,
    ),
    check(
      "Every outline section present",
      missingSections.length === 0,
      missingSections.length === 0
        ? `All ${outline.length} planned sections are present.`
        : `Missing section(s): ${missingSections.join("; ")}.`,
    ),
    check(
      "Meta description within length",
      !metaDescription || metaDescription.length <= META_DESCRIPTION_MAX_CHARS,
      metaDescription
        ? `Meta description is ${metaDescription.length} characters (limit ${META_DESCRIPTION_MAX_CHARS}).`
        : "No meta description was produced.",
    ),
    check(
      "Article length reasonable",
      wordCount >= ARTICLE_MIN_WORDS && wordCount <= ARTICLE_MAX_WORDS,
      `Article is ${wordCount} words; the target band is ${ARTICLE_MIN_WORDS}–${ARTICLE_MAX_WORDS}.`,
    ),
  ];

  return {
    // Paragraph length and article length are advisory: the SEO asset calls
    // them guidance, and failing an article for a four-sentence paragraph
    // would block on something a human would not.
    passed: checks
      .filter((c) => !["Short paragraphs", "Article length reasonable"].includes(c.name))
      .every((c) => c.passed),
    checks,
    keywordInTitle,
    keywordInFirst100,
    exactlyOneH1: h1s.length === 1,
    hasH2s: h2s.length >= 2,
    linkCount: links.length,
    linksResolve,
    longParagraphs,
    wordCount,
    missingSections,
  };
}

/** Word overlap, for matching a written heading to its planned intent. */
function overlapRatio(a: string, b: string): number {
  const wordsA = new Set(a.split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.split(/\W+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const shared = [...wordsA].filter((w) => wordsB.has(w)).length;
  return shared / Math.min(wordsA.size, wordsB.size);
}

/** Banned phrases are computed as well as judged (§11.1). */
export function findBannedPhrases(text: string, banned: string[]): string[] {
  const haystack = text.toLowerCase();
  return banned.filter((phrase) => haystack.includes(phrase.toLowerCase()));
}

/**
 * Em dashes and their close relatives.
 *
 * The single clearest tell that a machine wrote the text, and asking the model
 * not to use them does not work reliably — so it is measured and repaired in
 * code rather than trusted (rule 2: verify the instruction, do not trust it).
 *
 * The en dash is included when it separates words; between digits it is a
 * legitimate range ("2020–2024") and is left alone.
 */
const EM_DASH_PATTERN = /\s*—\s*|\s*―\s*|(?<=\D)\s*–\s*(?=\D)/g;

export function countEmDashes(text: string): number {
  return (text.match(EM_DASH_PATTERN) ?? []).length;
}

/**
 * Rewrites em dashes into ordinary punctuation.
 *
 * A dash joining two clauses becomes a comma, which reads naturally in almost
 * every case. A dash at the end of a clause (before a closing bracket, or at
 * the end of a line) is simply removed along with its surrounding space.
 */
export function replaceEmDashes(text: string): string {
  return text
    // A dash that already runs into punctuation contributes nothing and would
    // otherwise become ", ," or ", ." — drop it and keep the punctuation.
    .replace(/\s*[—―]\s*(?=[.,;:!?])/g, "")
    // A parenthetical pair "word — aside — word" reads correctly with commas.
    .replace(/\s+—\s+/g, ", ")
    .replace(/\s+―\s+/g, ", ")
    .replace(/(?<=\D)\s+–\s+(?=\D)/g, ", ")
    // No surrounding spaces: "word—word" becomes "word, word".
    .replace(/(\S)—(\S)/g, "$1, $2")
    .replace(/(\S)―(\S)/g, "$1, $2")
    .replace(/(?<=\D)–(?=\D)/g, ", ")
    // A dash left touching punctuation would produce ", ." or ", ,".
    .replace(/,\s*([.,;:!?])/g, "$1")
    .replace(/,\s*,/g, ",");
}

// ─── Channel format checks (§12.1) ──────────────────────────────────────────

export interface LinkedInCheckInput {
  body: string;
  cta: string | null;
  pas: { problem: string; agitation: string; solution: string } | null;
  emojiAllowance: number;
}

/**
 * PAS structure, paragraph length, emoji allowance, CTA, 3000 characters.
 * The output declares its problem/agitation/solution spans and they are
 * checked for presence, order and non-overlap (§12.1).
 */
export function checkLinkedIn(input: LinkedInCheckInput): FormatCheckResult {
  const { body, cta, pas, emojiAllowance } = input;
  const limits = CHANNEL_LIMITS.linkedin;

  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const longParagraphs = paragraphs.filter(
    (p) => p.split("\n").length > limits.maxLinesPerParagraph,
  );
  const emoji = countEmoji(body);

  const checks: Check[] = [
    check(
      "Within 3000 characters",
      body.length <= limits.maxChars,
      `Post is ${body.length} characters (limit ${limits.maxChars}).`,
    ),
    check(
      "PAS structure declared",
      pas !== null && Boolean(pas.problem && pas.agitation && pas.solution),
      pas
        ? "Problem, agitation and solution spans are all present."
        : "The post did not declare its problem, agitation and solution spans.",
    ),
    check(
      "PAS spans appear in order and do not overlap",
      pasSpansValid(body, pas),
      pas ? describePasOrder(body, pas) : "No PAS spans to check.",
    ),
    check(
      "Short paragraphs",
      longParagraphs.length === 0,
      longParagraphs.length === 0
        ? `All ${paragraphs.length} paragraphs are ${limits.maxLinesPerParagraph} lines or fewer.`
        : `${longParagraphs.length} paragraph(s) run longer than ${limits.maxLinesPerParagraph} lines.`,
    ),
    check(
      "Emoji within the brand voice allowance",
      emoji <= Math.min(emojiAllowance, limits.maxEmoji),
      `Found ${emoji} emoji; the allowance is ${Math.min(emojiAllowance, limits.maxEmoji)}.`,
    ),
    check(
      "Ends with a call to action",
      Boolean(cta?.trim()) && endsWithCta(body, cta),
      cta?.trim()
        ? endsWithCta(body, cta)
          ? "The CTA is the final block."
          : "A CTA was provided but it is not the final block of the post."
        : "No call to action was provided.",
    ),
  ];

  return { passed: checks.every((c) => c.passed), checks };
}

function pasSpansValid(
  body: string,
  pas: { problem: string; agitation: string; solution: string } | null,
): boolean {
  if (!pas) return false;
  const p = body.indexOf(pas.problem.slice(0, 40));
  const a = body.indexOf(pas.agitation.slice(0, 40));
  const s = body.indexOf(pas.solution.slice(0, 40));
  if (p === -1 || a === -1 || s === -1) return false;
  return p < a && a < s;
}

function describePasOrder(
  body: string,
  pas: { problem: string; agitation: string; solution: string } | null,
): string {
  if (!pas) return "No PAS spans to check.";
  return pasSpansValid(body, pas)
    ? "Problem, then agitation, then solution, in order and distinct."
    : "The declared PAS spans are missing from the body or are out of order.";
}

function endsWithCta(body: string, cta: string | null): boolean {
  if (!cta?.trim()) return false;
  const tail = body.trim().slice(-Math.max(cta.length + 80, 160)).toLowerCase();
  return tail.includes(cta.trim().toLowerCase().slice(0, 30));
}

export interface XCheckInput {
  body: string;
  hashtags: string[];
  coreIdea: string | null;
  includesLink: boolean;
}

/**
 * 280 characters counted the way the platform counts, 1–2 hashtags, at least
 * one line break, exactly one core idea (§12.1).
 */
export function checkX(input: XCheckInput): FormatCheckResult {
  const { body, hashtags, coreIdea } = input;
  const limits = CHANNEL_LIMITS.x;

  // The tested counter, not String.length — counting `body.length` will pass
  // posts the API then rejects (§12.1, Conventions).
  const weighted = countXCharacters(body);

  const checks: Check[] = [
    check(
      "Within 280 characters, counted as the platform counts",
      weighted <= limits.maxChars,
      weighted <= limits.maxChars
        ? `Post weighs ${weighted} of ${limits.maxChars} characters.`
        : // Naming the OVERSHOOT, not just the total: "cut at least 40
          // characters" converges in one attempt where "it is 320" does not.
          `Post weighs ${weighted} characters and the limit is ${limits.maxChars}, ` +
          `cut at least ${weighted - limits.maxChars} characters. ` +
          `(Raw length ${body.length}; any URL counts as ${limits.urlWeight} however long it is.)`,
    ),
    check(
      "One or two hashtags",
      hashtags.length >= limits.minHashtags && hashtags.length <= limits.maxHashtags,
      `Found ${hashtags.length} hashtag${hashtags.length === 1 ? "" : "s"}; the rule is ${limits.minHashtags} to ${limits.maxHashtags}.`,
    ),
    check(
      "Uses a line break for readability",
      body.includes("\n"),
      body.includes("\n") ? "The post uses line breaks." : "The post is a single block with no line break.",
    ),
    check(
      "States one core idea",
      Boolean(coreIdea?.trim()) && coreIdea!.trim().length <= 120,
      !coreIdea?.trim()
        ? "The post did not declare its core idea."
        : coreIdea.trim().length <= 120
          ? `Core idea declared in ${coreIdea.trim().length} characters.`
          : // The limit was previously invisible in the failure message, so a
            // retry could not know what to aim for.
            `The core idea is ${coreIdea.trim().length} characters; it must be under 120. ` +
            `A core idea that needs a paragraph is more than one idea.`,
    ),
  ];

  return { passed: checks.every((c) => c.passed), checks };
}

export interface NewsletterCheckInput {
  subject: string | null;
  body: string;
  cta: string | null;
}

/**
 * Subject ≤ 65, intro 1–3 sentences, two subheadings or a bulleted block, a
 * CTA, a sign-off, and 250–600 words. The word count is a HARD failure with
 * one retry naming the actual count, because a model told the real number
 * usually fixes it (§12.1).
 */
export function checkNewsletter(input: NewsletterCheckInput): FormatCheckResult {
  const { subject, body, cta } = input;
  const limits = CHANNEL_LIMITS.newsletter;

  const words = countWords(body);
  const headings = parseHeadings(body);
  const hasBullets = /^\s*[-*+]\s+/m.test(body);
  const paragraphs = parseParagraphs(body);
  const introSentences = paragraphs[0] ? segmentSentences(stripMarkdown(paragraphs[0])).length : 0;
  const signOff = hasSignOff(body);

  const checks: Check[] = [
    check(
      "Subject line present and within 65 characters",
      Boolean(subject?.trim()) && (subject?.length ?? 0) <= limits.maxSubjectChars,
      subject?.trim()
        ? `Subject is ${subject.length} characters (limit ${limits.maxSubjectChars}).`
        : "No subject line was produced.",
    ),
    check(
      "Between 250 and 600 words",
      words >= limits.minWords && words <= limits.maxWords,
      `Newsletter is ${words} words; the rule is ${limits.minWords} to ${limits.maxWords}.`,
    ),
    check(
      "Intro of one to three sentences",
      introSentences >= limits.minIntroSentences && introSentences <= limits.maxIntroSentences,
      `The opening paragraph has ${introSentences} sentence${introSentences === 1 ? "" : "s"}.`,
    ),
    check(
      "Skimmable: subheadings or bullets",
      headings.length >= limits.minSubheadings || hasBullets,
      headings.length >= limits.minSubheadings
        ? `Found ${headings.length} subheadings.`
        : hasBullets
          ? "Uses a bulleted block."
          : `Found ${headings.length} subheadings and no bullets; needs ${limits.minSubheadings} subheadings or a bulleted block.`,
    ),
    check(
      "Clear call to action",
      Boolean(cta?.trim()),
      cta?.trim() ? "A CTA is present." : "No call to action was provided.",
    ),
    check(
      "Friendly sign-off",
      signOff,
      signOff ? "The newsletter signs off." : "No sign-off was found at the end.",
    ),
  ];

  return { passed: checks.every((c) => c.passed), checks };
}

/**
 * A sign-off is a short closing line followed by a sender.
 *
 * Matching a fixed list of openers ("Best", "Cheers", "Regards") rejected
 * perfectly good endings — "Cleaning on your terms,\nKoya Talent" failed twice
 * in a row, so the channel was marked format_failed over a check that was
 * itself wrong. The SHAPE is what identifies a sign-off, not the vocabulary.
 */
function hasSignOff(body: string): boolean {
  const lines = body
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // The last two lines: a closing phrase ending in a comma, then a name.
  const last = lines[lines.length - 1];
  const penultimate = lines[lines.length - 2];

  if (!last) return false;

  // "Cleaning on your terms,\nKoya Talent" — a short comma-terminated line
  // followed by a short line that is not a sentence.
  if (
    penultimate &&
    /,\s*$/.test(penultimate) &&
    penultimate.length <= 60 &&
    last.length <= 60 &&
    !/[.!?]$/.test(last)
  ) {
    return true;
  }

  // "— Koya Talent" or "-- The team", on its own.
  if (/^[—–-]{1,2}\s*\S/.test(last) && last.length <= 60) return true;

  // The conventional openers still count, wherever they appear at the end.
  const tail = lines.slice(-3).join(" ").toLowerCase();
  return /\b(best|cheers|thanks|thank you|regards|talk soon|until next|see you|warmly|sincerely|yours)\b/.test(
    tail,
  );
}
