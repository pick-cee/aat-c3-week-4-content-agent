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

interface PlannedAngle {
  label: string;
  headline: string;
  outline: { heading: string; intent: string }[];
  primaryKeyword: string;
  secondaryKeywords: string[];
  excerptLabels: string[];
  rationale: string;
}

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
            description:
              "The article headline. MUST contain primaryKeyword as a contiguous " +
              "phrase, word for word. Checked by literal string match.",
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
          primaryKeyword: {
            type: "string",
            description:
              "Two or three words, lifted verbatim from the headline above. Not a " +
              "description of the topic: a phrase that literally appears in it.",
          },
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

  warnings: string[];
}

export function keywordFromHeadline(headline: string, intended: string): string | null {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at",
    "is", "are", "was", "were", "why", "how", "what", "when", "your", "you",
    "it", "its", "that", "this", "with", "than", "from", "can", "will",
  ]);

  const words = headline
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return null;

  const intendedWords = new Set(
    intended.toLowerCase().split(/\s+/).filter((w) => w && !stop.has(w)),
  );
  let best: { phrase: string; overlap: number } | null = null;

  for (let size = 3; size >= 2; size--) {
    for (let i = 0; i + size <= words.length; i++) {
      const run = words.slice(i, i + size);
      if (run.some((w) => stop.has(w))) continue;

      const phrase = run.join(" ");
      const overlap = run.filter((w) => intendedWords.has(w)).length;

      if (!best || overlap > best.overlap) best = { phrase, overlap };
    }
    if (best && best.overlap > 0) break;
  }

  if (best && containsKeyword(headline, best.phrase)) return best.phrase;
  const content = words.filter((w) => !stop.has(w));
  if (content.length >= 2) {
    const phrase = content.slice(0, 2).join(" ");
    if (containsKeyword(headline, phrase)) return phrase;
  }

  return null;
}

interface Violation {
  message: string;
  fixable: boolean;
}

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

        "- The primary keyword MUST appear in the headline as a CONTIGUOUS phrase,\n" +
        "  word for word, in that order. This is a literal string check: a headline\n" +
        "  about 'hiring delays' does NOT satisfy the keyword 'hiring bottlenecks'.\n" +
        "- Keep the keyword SHORT, two or three words, and choose it by writing the\n" +
        "  headline first and then lifting the phrase out of it. Do not invent a\n" +
        "  keyword that describes the topic and hope the headline matches it.\n" +
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
  const MAX_ATTEMPTS = 2;

  type AngleSet = { angles: PlannedAngle[] };
  let lastResult: AngleSet | null = null;
  let lastViolations: string[] = [];
  let previousAttempt: AngleSet | null = null;
  let retryNote = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
    if (lastResult === null || violations.length < lastViolations.length) {
      lastResult = result.value;
      lastViolations = violations.map((v) => v.message);
    }
    previousAttempt = result.value;
    retryNote = buildRetryNote(fixable.map((v) => v.message), previousAttempt);

    await recordDiscarded(
      context,
      MODELS.planning,
      result.usage,
      `Angle constraints violated: ${fixable.map((v) => v.message).join("; ")}`,
      result.callId,
    );
  }
  await logWarn(
    "The angles are more similar than they should be, after a rewrite. They are shown anyway so you can choose or re-plan.",
    { requestId: request.id, step: "plan", detail: { violations: lastViolations } },
  );


  if (!lastResult) {
    throw new Error(
      "Angle planning could not complete: every attempt failed before returning a " +
        "result. The sources are saved, so retrying resumes from here.",
    );
  }

  return { angles: lastResult.angles, warnings: lastViolations };
}

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

async function checkAngleConstraints(
  angles: PlannedAngle[],
  digest: SourceDigestEntry[],
  request: ContentRequest,
): Promise<Violation[]> {
  const violations: Violation[] = [];
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
      const repaired = keywordFromHeadline(angle.headline, angle.primaryKeyword);
      if (repaired) {
        angle.primaryKeyword = repaired;
      } else {
        violations.push({
          message: `Angle ${i + 1} headline "${angle.headline}" does not contain its primary keyword "${angle.primaryKeyword}", and no usable phrase could be taken from it.`,
          fixable: true,
        });
      }
    }


    const requiredSources = Math.min(MIN_SOURCES_PER_ANGLE, digest.length);

    const sources = new Set(
      (angle.excerptLabels ?? []).map((l) => labelToSource.get(l)).filter(Boolean),
    );
    if (sources.size < requiredSources) {
      violations.push({
        message: `Angle ${i + 1} draws on ${sources.size} source(s); it must use at least ${requiredSources}.`,
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
            fixable: digest.length >= MIN_SOURCES_PER_ANGLE,
          });
        }
      }
    }
  } catch (error) {
    throw error;
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
  let excerptIndex = 0;

  return sources.map((source, i) => {
    const list = bySource.get(source.id as string) ?? [];
    const snippets = list.slice(0, 3).map((e) => {
      excerptIndex++;
      return { label: `E${excerptIndex}`, text: truncate(e.text, 220) };
    });
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

export async function saveAngles(
  requestId: string,
  angles: PlannedAngle[],
  excerptLabelToId: Map<string, string>,
): Promise<void> {
  const db = serviceClient();
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
