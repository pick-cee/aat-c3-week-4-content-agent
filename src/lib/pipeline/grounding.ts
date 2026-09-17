import "server-only";
import { BudgetExceededError } from "@/lib/cost";
import { MissingEnvError } from "@/lib/env";
import { segmentSentences, stripMarkdown, type Sentence } from "@/lib/text";
import { embed, cosineSimilarity, parseVector } from "@/lib/providers/embeddings";
import {
  GROUNDING_STRONG_THRESHOLD,
  GROUNDING_WEAK_THRESHOLD,
} from "@/lib/constants";
import type { ClaimMapEntry } from "@/lib/db/types";

/**
 * The excerpt ledger and grounding enforcement. DESIGN.md §8.
 *
 * "Grounding is a property of the structure, not a thing we ask the model to
 * be careful about." Three mechanisms, in order of strength:
 *
 *   §8.3  Marker integrity — mechanical, no model. A marker that does not
 *         resolve to an excerpt supplied to that call is a HARD FAILURE. A
 *         hallucinated citation cannot reach a reviewer; it is not detected
 *         and warned about, it is structurally impossible to store.
 *
 *   §8.4  The vector check — marker integrity proves a citation EXISTS; it
 *         does not prove the sentence has anything to do with it. Comparing
 *         sentence to excerpt by cosine distance catches a real citation
 *         attached to a claim it does not support.
 *
 *   §8.5  The tripwire — unmarked sentences carrying numbers, dates, quotes or
 *         unknown proper nouns. The model was instructed to cite its claims;
 *         rather than trust the instruction, measure its outcome.
 */

// ─── The labelled excerpt set ───────────────────────────────────────────────

export interface LabelledExcerpt {
  /** Short per-request label, e.g. "E12". The model never sees a UUID. */
  label: string;
  excerptId: string;
  sourceId: string;
  /** Short source label, e.g. "S3". */
  sourceLabel: string;
  text: string;
  headingPath: string | null;
  sourceTitle: string | null;
  sourceUrl: string;
  siteName: string | null;
  publishedAt: string | null;
  embedding: number[] | null;
}

/**
 * Renders the excerpt set in the format §8.1 specifies. The identifiers are
 * short labels assigned per request and mapped back to `excerpts.id` in a
 * lookup the server holds — the model never sees a UUID and so cannot
 * fabricate a plausible one.
 */
export function renderExcerptsForPrompt(excerpts: LabelledExcerpt[]): string {
  return excerpts
    .map((e) => {
      const meta = [e.siteName, e.publishedAt?.slice(0, 10)].filter(Boolean).join(", ");
      // A field separator in the prompt's own structure, not prose a person
      // reads, so the em dash rule does not apply here.
      const header = `[${e.label}] source ${e.sourceLabel} — "${e.sourceTitle ?? "Untitled"}"${
        meta ? ` (${meta})` : ""
      }`;
      const heading = e.headingPath ? `\n      §${e.headingPath}` : "";
      return `${header}${heading}\n      ${e.text.replace(/\n/g, "\n      ")}`;
    })
    .join("\n\n");
}

/** Assigns E-labels and S-labels. Stable within one call, by construction. */
export function labelExcerpts(
  rows: {
    id: string;
    source_id: string;
    text: string;
    heading_path: string | null;
    embedding?: unknown;
  }[],
  sources: Map<
    string,
    { title: string | null; url: string; site_name: string | null; published_at: string | null }
  >,
): LabelledExcerpt[] {
  const sourceLabels = new Map<string, string>();

  return rows.map((row, index) => {
    if (!sourceLabels.has(row.source_id)) {
      sourceLabels.set(row.source_id, `S${sourceLabels.size + 1}`);
    }
    const source = sources.get(row.source_id);

    return {
      label: `E${index + 1}`,
      excerptId: row.id,
      sourceId: row.source_id,
      sourceLabel: sourceLabels.get(row.source_id)!,
      text: row.text,
      headingPath: row.heading_path,
      sourceTitle: source?.title ?? null,
      sourceUrl: source?.url ?? "",
      siteName: source?.site_name ?? null,
      publishedAt: source?.published_at ?? null,
      embedding: row.embedding ? parseVector(row.embedding as string) : null,
    };
  });
}

// ─── §8.3 Marker integrity ──────────────────────────────────────────────────

/**
 * A marker is `[E12]`, or `[E1, E2]` for a sentence resting on two excerpts.
 *
 * Built fresh per use rather than shared: a global regex carries `lastIndex`
 * between `exec` calls, so a single shared instance silently skips markers
 * depending on what ran before it.
 */
const markerPattern = () => /\[(E\d+(?:\s*,\s*E\d+)*)\]/g;

/**
 * Sentences carrying their own markers, in document order.
 *
 * §8.3 puts the marker AFTER the terminating full stop ("...end with one or
 * more markers `[E12]`"), and `Intl.Segmenter` — correctly, by Unicode rules —
 * treats the stop as the sentence boundary and hands the marker to the NEXT
 * segment. Segmenting naively therefore scores every claim against its
 * neighbour's citation and shifts the entire claim map by one.
 *
 * So markers are pulled back onto the sentence they terminate before anything
 * else looks at them.
 */
export function segmentSentencesWithMarkers(text: string): Sentence[] {
  const raw = segmentSentences(text);
  const out: Sentence[] = [];

  for (const segment of raw) {
    // A segment that is nothing but markers belongs to the sentence before it.
    const leadingMarkers = /^((?:\s*\[E\d+(?:\s*,\s*E\d+)*\])+)\s*/.exec(segment.text);
    const previous = out[out.length - 1];

    if (leadingMarkers && previous) {
      const markers = leadingMarkers[1]!.trim();
      const remainder = segment.text.slice(leadingMarkers[0].length).trim();

      previous.text = `${previous.text} ${markers}`;
      previous.end = segment.start + leadingMarkers[0].length;

      if (remainder.length === 0) continue;

      out.push({
        index: out.length,
        text: remainder,
        start: segment.start + leadingMarkers[0].length,
        end: segment.end,
      });
      continue;
    }

    out.push({ ...segment, index: out.length });
  }

  return out;
}

/** Every marker in the text, in order of appearance. */
export function extractMarkers(text: string): string[] {
  const found: string[] = [];
  const pattern = markerPattern();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    for (const label of match[1]!.split(",")) found.push(label.trim());
  }

  return found;
}

export interface MarkerIntegrityResult {
  valid: boolean;
  /** Labels used in the body that were never supplied to the call. */
  unknownLabels: string[];
  usedLabels: string[];
}

/**
 * §8.3 step 2: any marker not in the set supplied to that call is a hard
 * failure. The caller discards the generation (logging the tokens), retries
 * once naming the offending identifiers, and stops the request on a second
 * failure.
 */
export function checkMarkerIntegrity(
  body: string,
  supplied: LabelledExcerpt[],
): MarkerIntegrityResult {
  const allowed = new Set(supplied.map((e) => e.label));
  const used = extractMarkers(body);
  const unknown = [...new Set(used.filter((label) => !allowed.has(label)))];

  return {
    valid: unknown.length === 0,
    unknownLabels: unknown,
    usedLabels: [...new Set(used)],
  };
}

// ─── §8.5 The tripwire ──────────────────────────────────────────────────────

/**
 * A sentence asserts something checkable if it carries a digit, a percentage,
 * a currency symbol, a four-digit year, a quotation, or a capitalised
 * multi-word phrase that appears nowhere in the material we gave the model.
 */
const YEAR = /\b(19|20)\d{2}\b/;
const DIGIT = /\d/;
const CURRENCY = /[$£€₦¥]/;
const PERCENT = /\d\s*%|\bpercent\b/i;
const QUOTATION = /["“”].{6,}["“”]/;
/**
 * Built per use. A global regex used with `.test()` advances `lastIndex` and
 * returns false on the next call against a matching string, which would make
 * the factual-sentence count depend on call order.
 */
const properPhrasePattern = () => /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+)\b/g;

export interface TripwireHit {
  sentenceIndex: number;
  sentence: string;
  reasons: string[];
}

/**
 * Flags unmarked sentences that should not be unmarked (§8.5). This is the
 * Week 3 commercial-terms check applied to editorial content: if you can
 * measure whether an instruction was followed, measure it.
 */
export function runTripwire(
  body: string,
  knownText: string[],
): TripwireHit[] {
  const haystack = knownText.join("\n").toLowerCase();
  const hits: TripwireHit[] = [];

  segmentSentencesWithMarkers(stripMarkdownKeepingMarkers(proseOnly(body))).forEach((sentence) => {
    // Only unmarked sentences are candidates — a marked one is the vector
    // check's business, not the tripwire's.
    if (extractMarkers(sentence.text).length > 0) return;

    const bare = stripMarkers(sentence.text).trim();
    const reasons: string[] = [];

    if (PERCENT.test(bare)) reasons.push("states a percentage");
    else if (CURRENCY.test(bare)) reasons.push("states a monetary amount");
    else if (YEAR.test(bare)) reasons.push("states a year");
    else if (DIGIT.test(bare) && !isHarmlessNumber(bare)) reasons.push("states a figure");

    if (QUOTATION.test(bare)) reasons.push("contains a quotation");

    for (const match of bare.matchAll(properPhrasePattern())) {
      const phrase = match[1]!;
      if (!haystack.includes(phrase.toLowerCase())) {
        reasons.push(`names "${phrase}", which appears in no source`);
        break;
      }
    }

    if (reasons.length > 0) {
      hits.push({ sentenceIndex: sentence.index, sentence: bare, reasons });
    }
  });

  return hits;
}

/**
 * Ordinals, list positions and step numbers are not factual claims. Without
 * this, "Three things matter here." trips the wire on every article and the
 * signal drowns in noise.
 */
function isHarmlessNumber(sentence: string): boolean {
  const numbers = sentence.match(/\d+(?:\.\d+)?/g) ?? [];
  return numbers.every((n) => {
    const value = Number.parseFloat(n);
    return Number.isInteger(value) && value >= 1 && value <= 10;
  });
}

/**
 * Strips markdown but leaves `[E1]` markers intact.
 *
 * `stripMarkdown` treats `[text](url)` as a link and reduces it to its anchor,
 * which also eats a bare `[E1]`. Without this protection every marked sentence
 * arrives here looking unmarked: the tripwire fires on correctly-cited claims
 * and the claim map comes back empty. Placeholders survive the strip and are
 * restored afterwards.
 */
/**
 * Drops the lines that are structure rather than prose.
 *
 * A heading cannot carry a citation, and neither can a table row: a marker on
 * an H2 would render inside the heading. The tripwire scanned them anyway and
 * flagged each as an uncited claim:
 *
 *   "How to Run Structured Interviews: The Four-Step Process That Matters"
 *   "Score Rating Behavioral Indicators"
 *   "3 Adequate Relevant example, but lacking detail or measurable outcomes."
 *
 * Three of the four flags that sent one request to `needs_human` were these.
 * No revision could clear them, because nothing was wrong.
 */
function proseOnly(markdown: string): string {
  return markdown
    // A link marker names the excerpt its URL comes from, so a sentence
    // carrying one IS attributed. Left in place it reads as bare prose that
    // happens to mention a source, and the tripwire flags it as uncited.
    .replace(/\(\(link:[^|)]*\|\s*(E\d+)\s*\)\)/g, "[$1]")
    .replace(/\(\(link:[^)]*\)\)/g, " ")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("#")) return false;
      // A table row, and the |---|---| rule beneath its header.
      if (t.startsWith("|")) return false;
      return true;
    })
    .join("\n");
}

function stripMarkdownKeepingMarkers(markdown: string): string {
  const held: string[] = [];

  const protectedText = markdown.replace(markerPattern(), (match) => {
    held.push(match);
    // Letters and digits only, so markdown stripping leaves it untouched, and
    // an improbable prefix so it cannot collide with words in the article.
    return `zqmarkerzq${held.length - 1}zq`;
  });

  return stripMarkdown(protectedText).replace(
    /zqmarkerzq(\d+)zq/g,
    (_full, index: string) => held[Number(index)] ?? "",
  );
}

// ─── §8.4 The vector check, and the claim map ───────────────────────────────

export interface BuildClaimMapInput {
  previous?: ClaimMapEntry[];
  body: string;
  excerpts: LabelledExcerpt[];
  requestId: string;
  step: string;
}

export interface ClaimMapResult {
  claimMap: ClaimMapEntry[];
  weak: ClaimMapEntry[];
  unsupported: ClaimMapEntry[];
  markedCount: number;
  factualCount: number;
  markedRatio: number;
  tripwireHits: TripwireHit[];
  /** True when sentences could not be embedded, so scores are unknown. */
  degraded: boolean;
  degradedReason?: string;
}

/**
 * Builds the claim map and scores every marked sentence against the excerpts
 * it cites (§8.3 step 3, §8.4).
 *
 * A failure to embed does NOT silently pass the article: every score becomes
 * null with verdict `unscored`, `degraded` is set, and the evaluator treats an
 * unscored grounding check as un-judgeable rather than as a pass (§5.8,
 * "unknown is not zero").
 */
export async function buildClaimMap(input: BuildClaimMapInput): Promise<ClaimMapResult> {
  const { body, excerpts, requestId, step } = input;
  const byLabel = new Map(excerpts.map((e) => [e.label, e]));

  const sentences = segmentSentencesWithMarkers(stripMarkdownKeepingMarkers(proseOnly(body)));
  const entries: ClaimMapEntry[] = [];
  const markedIndices: number[] = [];

  sentences.forEach((sentence) => {
    const labels = [...new Set(extractMarkers(sentence.text))];
    if (labels.length === 0) return;

    const cited = labels.map((l) => byLabel.get(l)).filter((e): e is LabelledExcerpt => !!e);

    entries.push({
      sentenceIndex: sentence.index,
      sentence: stripMarkers(sentence.text).trim(),
      labels,
      excerptIds: cited.map((e) => e.excerptId),
      sourceIds: [...new Set(cited.map((e) => e.sourceId))],
      groundingScore: null,
      verdict: "unscored",
    });
    markedIndices.push(entries.length - 1);
  });

  let degraded = false;
  let degradedReason: string | undefined;

  // Reuse only identical claims citing exactly the same stored excerpts.
  const previous = new Map((input.previous ?? []).map(e => [JSON.stringify([e.sentence, e.labels, e.excerptIds]), e]));
  const pending = entries.filter(entry => {
    const saved = previous.get(JSON.stringify([entry.sentence, entry.labels, entry.excerptIds]));
    if (saved?.groundingScore != null && entry.labels.every(l => byLabel.get(l)?.embedding)) {
      entry.groundingScore = saved.groundingScore;
      entry.verdict = verdictFor(saved.groundingScore);
      return false;
    }
    return true;
  });
  if (pending.length > 0) {
    try {
      // Embedded as a QUERY, matching how the excerpts were embedded as
      // documents — the input types are not interchangeable.
      const { embeddings } = await embed(
        pending.map((e) => e.sentence),
        "query",
        { requestId, step },
      );

      pending.forEach((entry, i) => {
        const sentenceVector = embeddings[i];
        if (!sentenceVector) return;

        let best: number | null = null;
        for (const label of entry.labels) {
          const excerpt = byLabel.get(label);
          if (!excerpt?.embedding) continue;
          const score = cosineSimilarity(sentenceVector, excerpt.embedding);
          if (best === null || score > best) best = score;
        }

        entry.groundingScore = best;
        entry.verdict = verdictFor(best);
      });
    } catch (err) {
      // Unknown is not zero: a failed check is `unscored`, not `grounded`.
      degraded = true;
      degradedReason =
        err instanceof Error
          ? `Sentence embeddings failed, so grounding could not be scored: ${err.message}`
          : "Sentence embeddings failed, so grounding could not be scored.";
    }
  }

  degraded ||= entries.some(e => e.groundingScore === null);
  const factualSentences = countFactualSentences(proseOnly(body));
  const knownText = excerpts.map((e) => e.text);

  return {
    claimMap: entries,
    weak: entries.filter((e) => e.verdict === "weak"),
    unsupported: entries.filter((e) => e.verdict === "unsupported"),
    markedCount: entries.length,
    factualCount: factualSentences,
    markedRatio: factualSentences === 0 ? 1 : entries.length / factualSentences,
    tripwireHits: runTripwire(body, knownText),
    degraded,
    ...(degradedReason ? { degradedReason } : {}),
  };
}

function verdictFor(score: number | null): ClaimMapEntry["verdict"] {
  if (score === null) return "unscored";
  if (score >= GROUNDING_STRONG_THRESHOLD) return "grounded";
  if (score >= GROUNDING_WEAK_THRESHOLD) return "weak";
  return "unsupported";
}

/**
 * Sentences that assert something about the world, marked or not. The
 * denominator of the marked-sentence ratio — counting every sentence would
 * punish an article for having a readable introduction, which §8.3 explicitly
 * permits to carry no marker.
 */
function countFactualSentences(body: string): number {
  return segmentSentencesWithMarkers(stripMarkdownKeepingMarkers(body)).filter((sentence) => {
    const bare = stripMarkers(sentence.text).trim();
    if (extractMarkers(sentence.text).length > 0) return true;
    if (bare.length < 25) return false;
    return (
      DIGIT.test(bare) ||
      QUOTATION.test(bare) ||
      properPhrasePattern().test(bare) ||
      // A declarative assertion about the world, as opposed to a question or
      // an instruction to the reader.
      /\b(is|are|was|were|has|have|shows?|found|reports?|according to)\b/i.test(bare)
    );
  }).length;
}

// ─── Link resolution (§10) ──────────────────────────────────────────────────

/**
 * "Never let a model write a URL" (rule 3). The model marks where a link
 * belongs and which excerpt it should point at; the server substitutes that
 * source's real URL. A link cannot be wrong because the model never writes one.
 */
export interface LinkIntent {
  anchor: string;
  label: string;
}

export function resolveLinks(
  body: string,
  intents: LinkIntent[],
  excerpts: LabelledExcerpt[],
): { body: string; resolved: { anchor: string; label: string; excerptId: string | null; sourceId: string | null; url: string | null }[] } {
  const byLabel = new Map(excerpts.map((e) => [e.label, e]));
  let output = body;

  const resolved = intents.map((intent) => {
    const excerpt = byLabel.get(intent.label);
    const url = excerpt?.sourceUrl ?? null;

    if (url && intent.anchor) {
      // Replace the first bare occurrence of the anchor text with a real link.
      // Already-linked occurrences are skipped: a nested link is invalid
      // markdown and would render as literal brackets.
      const pattern = new RegExp(
        `(?<!\\[)${escapeRegex(intent.anchor)}(?!\\]\\()`,
      );
      if (pattern.test(output)) {
        output = output.replace(pattern, `[${intent.anchor}](${url})`);
      }
    }

    return {
      anchor: intent.anchor,
      label: intent.label,
      excerptId: excerpt?.excerptId ?? null,
      sourceId: excerpt?.sourceId ?? null,
      url,
    };
  });

  return { body: output, resolved };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Channel outputs inherit markers and are checked against the article's claim
 * map. Any marker not in the article is a hard failure and a retry (§12).
 */
export function checkInheritedMarkers(
  channelBody: string,
  articleClaimMap: ClaimMapEntry[],
): { valid: boolean; unknownLabels: string[] } {
  const allowed = new Set(articleClaimMap.flatMap((entry) => entry.labels));
  const used = [...new Set(extractMarkers(channelBody))];
  const unknown = used.filter((label) => !allowed.has(label));
  return { valid: unknown.length === 0, unknownLabels: unknown };
}

/** Markers are an internal mechanism; a reader never sees them. */
export function stripMarkers(text: string): string {
  return text
    .replace(/\[(E\d+(?:\s*,\s*E\d+)*)\]/g, "")
    // Removing a marker leaves a space before the punctuation it preceded,
    // and a double space where it sat between two sentences.
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
