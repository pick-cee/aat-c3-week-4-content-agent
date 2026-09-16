import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/log";
import {
  callStructured,
  recordDiscarded,
  type CallResult,
} from "@/lib/providers/anthropic";
import { embed, cosineSimilarity } from "@/lib/providers/embeddings";
import { containsKeyword } from "@/lib/text";
import {
  MAX_TOKENS,
  MODELS,
  ANGLE_COUNT,
  ANGLE_OUTLINE_MIN_SECTIONS,
  ANGLE_OUTLINE_MAX_SECTIONS,
  MAX_ANGLE_OVERLAP,
  MIN_SOURCES_PER_ANGLE,
} from "@/lib/constants";
import type { BrandVoice, ContentRequest, OutlineSection } from "@/lib/db/types";
import { brandVoiceBlock, PUNCTUATION_BLOCK } from "./prompts";

/**
 * Angle planning. DESIGN.md §9, §2.2.
 *
 * Three ANGLES, not three articles: "Drafting three complete articles to throw
 * away two is roughly triple the cost of the most expensive step in the
 * pipeline for no extra information; the choice a human actually makes is
 * between directions, not between prose."
 *
 * Input is a compact digest of the selected sources, not the full corpus —
 * planning does not need it.
 */

interface PlannedAngle {
  label: string;
  headline: string;
  outline: { heading: string; intent: string }[];
  primaryKeyword: string;
  secondaryKeywords: string[];
  excerptLabels: string[];
  rationale: string;
}

/**
 * Structured outputs reject array length constraints entirely — `minItems`
 * other than 0 or 1 is refused with a 400, and `maxItems` is refused outright.
 * So the counts live in the DESCRIPTION (which the model reads) and in the
 * constraint check below (which decides).
 *
 * That is the §9 position anyway: "Constraints checked in code, not asked for
 * politely." A schema that could enforce the count would have been convenient;
 * this way the count is verified rather than assumed.
 */
export const ANGLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["angles"],
  properties: {
    angles: {
      type: "array",
      description: `Exactly ${ANGLE_COUNT} angles. Not fewer, not more.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "label",
          "headline",
          "outline",
          "primaryKeyword",
          "secondaryKeywords",
          "excerptLabels",
          "rationale",
        ],
        properties: {
          label: { type: "string", description: "A 2-4 word name for this direction." },
          headline: {
            type: "string",
            description: "The article headline. MUST contain the primary keyword.",
          },
          outline: {
            type: "array",
            description: `Between ${ANGLE_OUTLINE_MIN_SECTIONS} and ${ANGLE_OUTLINE_MAX_SECTIONS} H2 sections.`,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["heading", "intent"],
              properties: {
                heading: { type: "string", description: "The H2 section heading." },
                intent: { type: "string", description: "One line on what this section does." },
              },
            },
          },
          primaryKeyword: { type: "string" },
          secondaryKeywords: {
            type: "array",
            description: "At most 6 secondary keywords.",
            items: { type: "string" },
          },
          excerptLabels: {
            type: "array",
            items: { type: "string" },
            description: "Excerpt labels this angle would lean on, e.g. [\"E1\", \"E7\"].",
          },
          rationale: { type: "string", description: "One sentence on why this angle." },
        },
      },
    },
  },
} as const;

export interface SourceDigestEntry {
  sourceLabel: string;
  title: string;
  siteName: string;
  summary: string;
  snippets: { label: string; text: string }[];
}

export interface PlanResult {
  angles: PlannedAngle[];
  /** Constraint violations that survived the retry — advisory, not blocking. */
  warnings: string[];
}

/**
 * A broken constraint, and whether asking again could fix it.
 *
 * The distinction is what stops the pipeline burning three planning calls on
 * a request that cannot succeed. "Your headline is missing its keyword" is a
 * rewrite away; "each angle must use two sources" is unanswerable when only
 * one source exists, and retrying it spends money to be told the same thing.
 */
interface Violation {
  message: string;
  fixable: boolean;
}

/**
 * Produces exactly three angles and checks the §9 constraints IN CODE rather
 * than asking for them politely.
 *
 * A failed check retries with the violations named — twice, because the first
 * attempt often returns three rephrasings of one idea and needs to be told
 * precisely how. After three attempts the angles are surfaced anyway with a
 * warning: this is an advisory quality check, not a correctness gate, and
 * blocking the human here would be worse than showing them the options.
 */
export async function planAngles(
  request: ContentRequest,
  voice: BrandVoice | null,
  digest: SourceDigestEntry[],
  replanNote?: string,
): Promise<PlanResult> {
  const system = [
    {
      text:
        "You plan content angles for a marketing agency. You are given a content idea, an " +
        "audience, and a digest of source material that has already been read and approved.\n\n" +
        `Produce exactly ${ANGLE_COUNT} genuinely DIFFERENT directions the article could take.\n\n` +
        "This is the part people get wrong. Three restatements of one idea is not a " +
        "choice, and it is checked mechanically, the angles are embedded and compared, " +
        "and a set that is too similar is sent back.\n\n" +
        "Make them differ in KIND, not in wording. Across the three, vary:\n" +
        "  · who the reader is, a sceptic, a beginner, someone already sold\n" +
        "  · the shape, a how-to, a myth corrected, a comparison, a cost case,\n" +
        "    a what-goes-wrong piece\n" +
        "  · what it argues, they should be capable of disagreeing with each other\n\n" +
        "A useful test: if two of your headlines could sit under the same subheading " +
        "of a single article, they are too close.\n\n" +
        "Hard rules:\n" +
        "- The primary keyword MUST appear in the headline.\n" +
        `- Each angle must draw on at least ${MIN_SOURCES_PER_ANGLE} DIFFERENT sources.\n` +
        `- Each outline has ${ANGLE_OUTLINE_MIN_SECTIONS} to ${ANGLE_OUTLINE_MAX_SECTIONS} H2 sections.\n` +
        "- Only reference excerpt labels that appear in the digest below.\n" +
        "- Let the depth of each section reflect how strong the source material for it is.",
      cache: true,
    },
    ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
    { text: PUNCTUATION_BLOCK, cache: true },
  ];

  const prompt = buildPlanPrompt(request, digest, replanNote);
  const context = { requestId: request.id, step: "plan", purpose: "propose three angles" };

  // Two retries rather than one. The first attempt frequently returns three
  // rephrasings of the same idea, and telling the model precisely how it was
  // too similar usually fixes it — but only if it is asked again.
  const MAX_ATTEMPTS = 3;

  type AngleSet = { angles: PlannedAngle[] };

  // The best attempt so far, by violation count.
  let lastResult: AngleSet | null = null;
  let lastViolations: string[] = [];
  // The attempt just rejected, which is what the retry note quotes back.
  let previousAttempt: AngleSet | null = null;
  // Built from the FIXABLE violations only; empty on the first attempt.
  let retryNote = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Annotated explicitly: `result` feeds `lastResult`, which feeds
    // `buildRetryNote`, which is declared below — enough of a cycle that
    // inference gives up and falls back to `any`.
    const result: CallResult<AngleSet> = await callStructured<AngleSet>({
      context,
      model: MODELS.planning,
      system,
      prompt: attempt === 0 ? prompt : `${prompt}\n\n${retryNote}`,
      schema: ANGLE_SCHEMA,
      maxTokens: MAX_TOKENS.planning,
      temperature: 1,
    });

    const violations = await checkAngleConstraints(result.value.angles, digest, request);

    if (violations.length === 0) {
      return { angles: result.value.angles, warnings: [] };
    }

    /**
     * Only retry what a retry can fix.
     *
     * The waste this prevents: with two sources — one of them a sign-in page —
     * "each angle must draw on two distinct sources" cannot be satisfied by
     * any wording, so all three attempts failed the same check and burned
     * three planning calls to arrive where the first one did.
     *
     * A violation the model cannot act on is a fact about the RESEARCH, not
     * about the angles. Surface it once and stop.
     */
    const fixable = violations.filter((v) => v.fixable);

    if (fixable.length === 0) {
      await logWarn(
        "The angles are as distinct as the available sources allow. They are shown so you can " +
          "choose, or add sources and re-plan.",
        {
          requestId: request.id,
          step: "plan",
          detail: { violations: violations.map((v) => v.message) },
        },
      );
      return {
        angles: result.value.angles,
        warnings: violations.map((v) => v.message),
      };
    }

    // Keep the BEST attempt, not the most recent one. A later try can come
    // back worse, and handing the reviewer the worst of three because it
    // happened to be last would be a strange way to end.
    if (lastResult === null || violations.length < lastViolations.length) {
      lastResult = result.value;
      lastViolations = violations.map((v) => v.message);
    }

    // The retry prompt needs the attempt that was just rejected, whichever
    // one is being kept, and only the parts it can actually act on.
    previousAttempt = result.value;
    // Only the fixable ones go into the retry note: telling the model to use
    // two sources when two do not exist is asking it to fail again.
    retryNote = buildRetryNote(fixable.map((v) => v.message), previousAttempt);

    await recordDiscarded(
      context,
      MODELS.planning,
      result.usage,
      `Angle constraints violated: ${fixable.map((v) => v.message).join("; ")}`,
    );
  }

  // Still failing after three attempts. The angles are surfaced anyway — this
  // is an advisory quality check, not a correctness gate, and blocking the
  // human here would be worse than showing them the options (§9).
  await logWarn(
    "The angles are more similar than they should be, even after two rewrites. They are shown anyway so you can choose or re-plan.",
    { requestId: request.id, step: "plan", detail: { violations: lastViolations } },
  );

  return { angles: lastResult!.angles, warnings: lastViolations };
}

/**
 * The retry instruction.
 *
 * Naming the rule that was broken is not enough when the failure is "these are
 * all the same piece" — the model needs to see what it wrote and be told to
 * move away from it. So the previous headlines go back in, with an explicit
 * demand for three different KINDS of article rather than three phrasings.
 */
function buildRetryNote(
  violations: string[],
  previous: { angles: PlannedAngle[] } | null,
): string {
  const parts = [
    "── YOUR PREVIOUS ATTEMPT WAS REJECTED ──",
    "",
    "It broke these rules:",
    violations.map((v) => `- ${v}`).join("\n"),
  ];

  const tooSimilar = violations.some((v) => v.includes("similar"));

  if (tooSimilar && previous) {
    parts.push(
      "",
      "You proposed these, and they are variations of one idea:",
      previous.angles.map((a, i) => `  ${i + 1}. "${a.headline}"`).join("\n"),
      "",
      "Start over. Do not rephrase these, write three angles that a reader",
      "would recognise as DIFFERENT ARTICLES. Vary at least these:",
      "",
      "  · WHO it is for, a sceptic, a beginner, someone already convinced",
      "  · WHAT SHAPE it takes, a how-to, a myth-corrected, a comparison,",
      "    a cost argument, a case-led piece, a common-mistakes piece",
      "  · WHAT IT ARGUES, the angles should be able to disagree with each",
      "    other, not merely emphasise different nouns",
      "",
      "If two of your new headlines could sit under the same subheading of one",
      "article, they are still too close.",
    );
  }

  return parts.join("\n");
}

/**
 * The §9 constraints, checked in code:
 *   · the primary keyword must appear in the headline
 *   · each angle must reference at least two distinct sources
 *   · two angles must not share more than 70% of their outline intents,
 *     measured by embedding the outlines and comparing
 */
async function checkAngleConstraints(
  angles: PlannedAngle[],
  digest: SourceDigestEntry[],
  request: ContentRequest,
): Promise<Violation[]> {
  const violations: Violation[] = [];

  // Counts the schema used to guarantee. Structured outputs reject array
  // length constraints, so if these are not checked here they are not checked
  // at all — and "three angles" would quietly become however many arrived.
  if (angles.length !== ANGLE_COUNT) {
    violations.push({
      message: `You returned ${angles.length} angle(s); exactly ${ANGLE_COUNT} are required.`,
      fixable: true,
    });
  }

  const labelToSource = new Map<string, string>();
  for (const entry of digest) {
    for (const snippet of entry.snippets) labelToSource.set(snippet.label, entry.sourceLabel);
  }

  angles.forEach((angle, i) => {
    const sections = angle.outline?.length ?? 0;
    if (sections < ANGLE_OUTLINE_MIN_SECTIONS || sections > ANGLE_OUTLINE_MAX_SECTIONS) {
      violations.push({
        message: `Angle ${i + 1} has ${sections} outline section(s); the rule is ${ANGLE_OUTLINE_MIN_SECTIONS} to ${ANGLE_OUTLINE_MAX_SECTIONS}.`,
        fixable: true,
      });
    }

    if (!containsKeyword(angle.headline, angle.primaryKeyword)) {
      violations.push({
        message: `Angle ${i + 1} headline "${angle.headline}" does not contain its primary keyword "${angle.primaryKeyword}".`,
        fixable: true,
      });
    }

    /**
     * "At least two sources" is only meaningful when there ARE two sources.
     *
     * A request built on one page cannot satisfy it, so the check would fail
     * on every angle, every retry, forever — producing a wall of violations
     * that says nothing except that research was thin. The requirement is
     * therefore the lesser of the rule and what actually exists.
     */
    const requiredSources = Math.min(MIN_SOURCES_PER_ANGLE, digest.length);

    const sources = new Set(
      (angle.excerptLabels ?? []).map((l) => labelToSource.get(l)).filter(Boolean),
    );
    if (sources.size < requiredSources) {
      violations.push({
        message: `Angle ${i + 1} draws on ${sources.size} source(s); it must use at least ${requiredSources}.`,
        // Fixable only if there is somewhere else to draw from. With one
        // usable source no rewrite can satisfy this, and retrying spends
        // money to be told the same thing.
        fixable: digest.length > sources.size,
      });
    }

    const unknown = (angle.excerptLabels ?? []).filter((l) => !labelToSource.has(l));
    if (unknown.length > 0) {
      violations.push({
        message: `Angle ${i + 1} references ${unknown.join(", ")}, which are not in the digest.`,
        fixable: true,
      });
    }
  });

  // Overlap, measured rather than eyeballed. A failure to embed is not a
  // reason to reject the angles — it is a check that could not run.
  try {
    const texts = angles.map((a) =>
      [a.headline, ...(a.outline ?? []).map((s) => `${s.heading}: ${s.intent}`)].join(" "),
    );
    const { embeddings } = await embed(texts, "query", {
      requestId: request.id,
      step: "plan",
    });

    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        const a = embeddings[i];
        const b = embeddings[j];
        if (!a || !b) continue;
        const similarity = cosineSimilarity(a, b);
        if (similarity > MAX_ANGLE_OVERLAP) {
          violations.push({
            message: `Angles ${i + 1} and ${j + 1} are ${Math.round(similarity * 100)}% similar; they must differ by more than that to be a real choice.`,
            // Three genuinely different angles need material to differ ABOUT.
            // Off a single source they will always read alike, and asking
            // again just pays for the same answer.
            fixable: digest.length >= MIN_SOURCES_PER_ANGLE,
          });
        }
      }
    }
  } catch {
    // Advisory check, and unavailable is not failed.
  }

  return violations;
}

function buildPlanPrompt(
  request: ContentRequest,
  digest: SourceDigestEntry[],
  replanNote?: string,
): string {
  const parts = [
    `Content idea: ${request.idea}`,
    `Target audience: ${request.target_audience}`,
  ];

  if (request.primary_keyword) {
    parts.push(`Primary keyword (use this): ${request.primary_keyword}`);
  } else {
    parts.push("Primary keyword: not specified, propose one per angle.");
  }

  parts.push("\n── Source digest ──\n");

  for (const entry of digest) {
    parts.push(
      `${entry.sourceLabel}, "${entry.title}" (${entry.siteName})\n` +
        `  ${entry.summary}\n` +
        entry.snippets.map((s) => `  [${s.label}] ${s.text}`).join("\n"),
    );
  }

  if (replanNote) {
    parts.push(
      `\n── The reviewer asked for a different direction ──\n${replanNote}\n` +
        "Take this seriously: do not return variations of what you proposed before.",
    );
  }

  return parts.join("\n");
}

/**
 * Builds the compact digest planning receives: title, site, a one-line summary
 * from the first excerpt, and the top three excerpt snippets each (§9).
 */
export async function buildSourceDigest(requestId: string): Promise<SourceDigestEntry[]> {
  const db = serviceClient();

  const { data: sources } = await db
    .from(table("sources"))
    .select("id, title, site_name, url, relevance_score, fetch_status")
    .eq("request_id", requestId)
    .eq("included", true)
    .in("fetch_status", ["ok", "too_large", "redirected_offsite"])
    .order("relevance_score", { ascending: false, nullsFirst: false });

  if (!sources || sources.length === 0) return [];

  const { data: excerpts } = await db
    .from(table("excerpts"))
    .select("id, source_id, text, ordinal")
    .eq("request_id", requestId)
    .order("ordinal");

  const bySource = new Map<string, { id: string; text: string }[]>();
  for (const row of excerpts ?? []) {
    const list = bySource.get(row.source_id as string) ?? [];
    list.push({ id: row.id as string, text: row.text as string });
    bySource.set(row.source_id as string, list);
  }

  // Labels must match what drafting will use, so they are assigned in the same
  // order both times: source relevance, then excerpt ordinal.
  let excerptIndex = 0;

  return sources.map((source, i) => {
    const list = bySource.get(source.id as string) ?? [];
    const snippets = list.slice(0, 3).map((e) => {
      excerptIndex++;
      return { label: `E${excerptIndex}`, text: truncate(e.text, 220) };
    });
    // Keep the running index aligned with the full excerpt set.
    excerptIndex += Math.max(0, list.length - 3);

    return {
      sourceLabel: `S${i + 1}`,
      title: (source.title as string) ?? "Untitled",
      siteName: (source.site_name as string) ?? "",
      summary: truncate(list[0]?.text ?? "No summary available.", 200),
      snippets,
    };
  });
}

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

/** Persists the three angles for gate one. */
export async function saveAngles(
  requestId: string,
  angles: PlannedAngle[],
  excerptLabelToId: Map<string, string>,
): Promise<void> {
  const db = serviceClient();

  // A re-plan replaces the previous set rather than accumulating: the reviewer
  // is choosing between three options, not nine.
  await db.from(table("angles")).delete().eq("request_id", requestId).eq("chosen", false);

  const rows = angles.map((angle) => ({
    request_id: requestId,
    label: angle.label,
    headline: angle.headline,
    outline: angle.outline as unknown as OutlineSection[],
    primary_keyword: angle.primaryKeyword,
    secondary_keywords: angle.secondaryKeywords ?? [],
    excerpt_ids: (angle.excerptLabels ?? [])
      .map((l) => excerptLabelToId.get(l))
      .filter((id): id is string => Boolean(id)),
    rationale: angle.rationale,
    model_used: MODELS.planning,
  }));

  const { error } = await db.from(table("angles")).insert(rows);
  if (error) throw new Error(`Could not save the angles: ${error.message}`);

  await logInfo(`Proposed ${rows.length} angles for review.`, {
    requestId,
    step: "plan",
  });
}
