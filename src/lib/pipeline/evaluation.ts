import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/log";
import { callStructured, callText } from "@/lib/providers/anthropic";
import { buildClaimMap, type LabelledExcerpt } from "./grounding";
import { findBannedPhrases, runSeoChecks } from "./checks";
import { brandVoiceBlock, RUBRIC_BLOCK } from "./prompts";
import { saveVersion } from "./drafting";
import {
  MAX_TOKENS,
  MODELS,
  MAX_UNSUPPORTED_CLAIMS,
  MAX_WEAK_CITATION_RATIO,
  MIN_MARKED_SENTENCE_RATIO,
} from "@/lib/constants";
import { segmentSentences, stripMarkdown } from "@/lib/text";
import type {
  Angle,
  ArticleVersion,
  BrandVoice,
  ClaimMapEntry,
  ComputedChecks,
  ContentRequest,
  Evaluation,
  EvaluationStatus,
  JudgedCriterion,
  OutlineSection,
} from "@/lib/db/types";

/**
 * Evaluation and revision. DESIGN.md §11.
 *
 * The rubric splits (§2.6): Source Grounding, Factual Consistency, SEO Fit,
 * Channel Fit and Completeness are COMPUTED from the artefacts before a model
 * sees them. Topic Relevance, Audience Fit, Tone and Clarity are JUDGED.
 *
 * "A model grading its own grounding is a model marking its own homework, and
 * the parts that can be measured should never be opinions."
 *
 * The judge's own verdict is stored and displayed, but it does NOT decide. A
 * model that returns `pass` while a computed check is failing is overruled,
 * and the disagreement is logged (§11.2).
 */

// ─── The judged call ────────────────────────────────────────────────────────

export const JUDGED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "sectionsToRevise", "recommendedChanges", "overallStatus", "overallNote"],
  properties: {
    criteria: {
      type: "object",
      additionalProperties: false,
      required: ["topicRelevance", "audienceFit", "tone", "clarity"],
      properties: {
        topicRelevance: criterionSchema(),
        audienceFit: criterionSchema(),
        tone: criterionSchema(),
        clarity: criterionSchema(),
      },
    },
    sectionsToRevise: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "problem"],
        properties: {
          heading: { type: "string", description: "The H2 heading exactly as written." },
          problem: { type: "string", description: "The specific problem in this section." },
        },
      },
    },
    recommendedChanges: { type: "string" },
    overallStatus: { type: "string", enum: ["pass", "revise", "reject"] },
    overallNote: { type: "string" },
  },
} as const;

function criterionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["score", "reason"],
    properties: {
      /**
       * Nullable by design: a criterion the judge could not assess is null
       * WITH a reason, never a score, and never 0 (§11.1).
       *
       * No `minimum`/`maximum` — structured outputs reject numeric bounds the
       * same way they reject array lengths. The range is stated here and
       * clamped in `normaliseScore` below, because an out-of-range score would
       * otherwise flow into the pass/revise decision unchecked.
       */
      score: {
        type: ["integer", "null"],
        description: "1 to 5, or null if you genuinely could not assess it.",
      },
      reason: { type: "string" },
    },
  };
}

/**
 * Keeps a judged score inside 1–5, or null.
 *
 * The schema cannot enforce the range (see above), and §11.2 decides `reject`
 * on a score of 1 and `revise` on a 2 — so a stray 0 or 7 would change the
 * outcome silently. Anything outside the range becomes null, which is the
 * honest answer: it is not a score this rubric defines.
 */
function normaliseScore(value: unknown): 1 | 2 | 3 | 4 | 5 | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > 5) return null;
  return value as 1 | 2 | 3 | 4 | 5;
}

interface JudgedOutput {
  criteria: {
    topicRelevance: JudgedCriterion;
    audienceFit: JudgedCriterion;
    tone: JudgedCriterion;
    clarity: JudgedCriterion;
  };
  sectionsToRevise: { heading: string; problem: string }[];
  recommendedChanges: string;
  overallStatus: "pass" | "revise" | "reject";
  overallNote: string;
}

// ─── The whole evaluation ───────────────────────────────────────────────────

export interface EvaluateInput {
  request: ContentRequest;
  version: ArticleVersion;
  angle: Angle | null;
  voice: BrandVoice | null;
  excerpts: LabelledExcerpt[];
  allowedUrls: string[];
  channelsProduced: number;
}

export async function evaluateArticle(input: EvaluateInput): Promise<Evaluation> {
  const { request, version, angle, voice, excerpts, allowedUrls } = input;

  // ── Computed first, because these are facts (§14.2) ──

  const claim = await buildClaimMap({
    body: version.body_md,
    excerpts,
    requestId: request.id,
    step: "evaluate",
  });

  const outline = (angle?.outline ?? []) as OutlineSection[];

  const seo = runSeoChecks({
    title: version.title,
    metaDescription: version.meta_description,
    bodyMd: version.body_md,
    primaryKeyword: version.primary_keyword ?? "",
    secondaryKeywords: version.secondary_keywords ?? [],
    outline,
    allowedUrls,
  });

  const banned = voice ? findBannedPhrases(version.body_md, voice.banned_phrases) : [];
  const numberDisagreements = countNumberDisagreements(claim.claimMap, excerpts);

  const computed: ComputedChecks = {
    sourceGrounding: {
      markedSentences: claim.markedCount,
      factualSentences: claim.factualCount,
      markedRatio: claim.markedRatio,
      weakCount: claim.weak.length,
      unsupportedCount: claim.unsupported.length,
      passed:
        !claim.degraded &&
        claim.markedRatio >= MIN_MARKED_SENTENCE_RATIO &&
        claim.unsupported.length <= MAX_UNSUPPORTED_CLAIMS &&
        (claim.markedCount === 0 || claim.weak.length / claim.markedCount <= MAX_WEAK_CITATION_RATIO),
    },
    factualConsistency: {
      unsupportedCandidates: claim.tripwireHits.length,
      numberDisagreements,
      passed: claim.tripwireHits.length <= MAX_UNSUPPORTED_CLAIMS && numberDisagreements === 0,
    },
    seoFit: {
      keywordInTitle: seo.keywordInTitle,
      keywordInFirst100: seo.keywordInFirst100,
      exactlyOneH1: seo.exactlyOneH1,
      hasH2s: seo.hasH2s,
      linkCount: seo.linkCount,
      linksResolve: seo.linksResolve,
      longParagraphs: seo.longParagraphs,
      passed: seo.passed,
    },
    completeness: {
      outlineSectionsPresent: outline.length - seo.missingSections.length,
      outlineSectionsExpected: outline.length,
      channelsProduced: input.channelsProduced,
      channelsRequested: request.channels.length,
      passed: seo.missingSections.length === 0,
    },
    bannedPhrases: banned,
  };

  // ── Then judged ──

  let judged: JudgedOutput | null = null;
  let judgeError: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };

  try {
    const result = await callStructured<JudgedOutput>({
      context: { requestId: request.id, step: "evaluate", purpose: "judge the draft" },
      model: MODELS.evaluation,
      system: [
        {
          text:
            "You are an editor reviewing a draft against a rubric. You did not write it and " +
            "you are not being asked to agree with whoever did.\n\n" +
            "You are given the article, the brand voice, and the results of checks that were " +
            "already computed mechanically. Those computed results are FACTS — do not " +
            "re-litigate them, and do not award a criterion you are judging on the basis of " +
            "one you are not.\n\n" +
            "Be specific. \"The tone is off\" is not useful; \"paragraph three uses three " +
            "abstractions where the voice calls for a concrete example\" is.",
          cache: true,
        },
        { text: RUBRIC_BLOCK, cache: true },
        ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
      ],
      // Deliberately NOT given the drafting prompt or the model's rationale:
      // it is evaluating the artefact, not agreeing with the reasoning that
      // produced it (§11.1).
      prompt: buildJudgePrompt(request, version, computed),
      schema: JUDGED_SCHEMA,
      maxTokens: MAX_TOKENS.evaluation,
    });

    // Clamped before anything reads it, so an out-of-range score cannot reach
    // the pass/revise decision in §11.2.
    judged = {
      ...result.value,
      criteria: Object.fromEntries(
        Object.entries(result.value.criteria ?? {}).map(([key, criterion]) => [
          key,
          { ...criterion, score: normaliseScore(criterion?.score) },
        ]),
      ) as JudgedOutput["criteria"],
    };
    usage = result.usage;
  } catch (err) {
    judgeError = err instanceof Error ? err.message : String(err);
  }

  // ── The decision, computed from the parts in code (§11.2) ──

  const { status, overruled } = decide(computed, judged, claim);

  const { data, error } = await serviceClient()
    .from(table("evaluations"))
    .insert({
      article_version_id: version.id,
      request_id: request.id,
      status,
      computed: computed as never,
      judged: (judged?.criteria ?? null) as never,
      unsupported_claims: [...claim.unsupported, ...toEntries(claim.tripwireHits)] as never,
      weak_citations: claim.weak as never,
      sections_to_revise: (judged?.sectionsToRevise ?? []) as never,
      recommended_changes: judged?.recommendedChanges ?? null,
      overall_note: judged?.overallNote ?? null,
      judge_verdict: judged?.overallStatus ?? null,
      judge_overruled: overruled,
      model_used: MODELS.evaluation,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      error: judgeError,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Could not save the evaluation: ${error?.message ?? "no row"}`);
  }

  if (overruled) {
    await logWarn(
      `The reviewer model said "${judged?.overallStatus}" but a computed check is failing, so the computed result stands.`,
      { requestId: request.id, step: "evaluate", detail: { computed } },
    );
  }

  await logInfo(`Evaluation: ${status}.`, {
    requestId: request.id,
    step: "evaluate",
    detail: {
      marked: claim.markedCount,
      weak: claim.weak.length,
      unsupported: claim.unsupported.length,
    },
  });

  return data as unknown as Evaluation;
}

/**
 * §11.2, and the status is computed from the parts in CODE.
 *
 *   reject — any computed HARD failure, or any judged score of 1
 *   revise — grounding flags over threshold, a judged 2, or a failing SEO check
 *   pass   — otherwise
 */
function decide(
  computed: ComputedChecks,
  judged: JudgedOutput | null,
  claim: { degraded: boolean },
): { status: EvaluationStatus; overruled: boolean } {
  // An evaluation that could not run must never be indistinguishable from one
  // that passed, and can never become `pass` (§5.8).
  if (!judged) return { status: "not_evaluated", overruled: false };

  const scores = Object.values(judged.criteria).map((c) => c.score);
  // A null propagates: overall cannot be `pass` with one in it (§11.1).
  const hasNull = scores.some((s) => s === null);

  const hardFailure =
    computed.bannedPhrases.length > 0 ||
    !computed.completeness.passed ||
    !computed.seoFit.linksResolve;

  const anyOne = scores.some((s) => s === 1);
  if (hardFailure || anyOne) {
    return { status: "reject", overruled: judged.overallStatus === "pass" };
  }

  const needsRevision =
    !computed.sourceGrounding.passed ||
    !computed.factualConsistency.passed ||
    !computed.seoFit.passed ||
    scores.some((s) => s === 2) ||
    claim.degraded ||
    hasNull;

  if (needsRevision) {
    return { status: "revise", overruled: judged.overallStatus === "pass" };
  }

  return { status: "pass", overruled: false };
}

function buildJudgePrompt(
  request: ContentRequest,
  version: ArticleVersion,
  computed: ComputedChecks,
): string {
  return [
    `The request was: ${request.idea}`,
    `Target audience: ${request.target_audience}`,
    ``,
    `── Computed results (facts, already measured) ──`,
    `Source grounding: ${computed.sourceGrounding.markedSentences} of ${computed.sourceGrounding.factualSentences} factual sentences carry a citation. ` +
      `${computed.sourceGrounding.weakCount} weak, ${computed.sourceGrounding.unsupportedCount} unsupported. ` +
      `${computed.sourceGrounding.passed ? "PASS" : "FAIL"}`,
    `Factual consistency: ${computed.factualConsistency.unsupportedCandidates} unmarked sentences make checkable claims. ` +
      `${computed.factualConsistency.passed ? "PASS" : "FAIL"}`,
    `SEO: keyword in title ${yesNo(computed.seoFit.keywordInTitle)}, in first 100 words ${yesNo(computed.seoFit.keywordInFirst100)}, ` +
      `${computed.seoFit.linkCount} links. ${computed.seoFit.passed ? "PASS" : "FAIL"}`,
    `Completeness: ${computed.completeness.outlineSectionsPresent} of ${computed.completeness.outlineSectionsExpected} planned sections present.`,
    computed.bannedPhrases.length > 0
      ? `Banned phrases present: ${computed.bannedPhrases.join(", ")}`
      : `No banned phrases.`,
    ``,
    `── The article ──`,
    ``,
    version.body_md,
  ].join("\n");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function toEntries(hits: { sentenceIndex: number; sentence: string; reasons: string[] }[]): ClaimMapEntry[] {
  return hits.map((hit) => ({
    sentenceIndex: hit.sentenceIndex,
    sentence: hit.sentence,
    labels: [],
    excerptIds: [],
    sourceIds: [],
    groundingScore: null,
    verdict: "unsupported" as const,
  }));
}

/**
 * Factual Consistency, computed part: does a number in a cited sentence
 * actually appear in the excerpt it cites? A citation that exists and is
 * topically close can still attach to a figure the source never stated.
 */
function countNumberDisagreements(
  claimMap: ClaimMapEntry[],
  excerpts: LabelledExcerpt[],
): number {
  const byLabel = new Map(excerpts.map((e) => [e.label, e]));
  let disagreements = 0;

  for (const entry of claimMap) {
    const numbers = extractSignificantNumbers(entry.sentence);
    if (numbers.length === 0) continue;

    const citedText = entry.labels
      .map((l) => byLabel.get(l)?.text ?? "")
      .join(" ");
    if (!citedText) continue;

    for (const number of numbers) {
      if (!citedText.includes(number)) {
        disagreements++;
        break;
      }
    }
  }

  return disagreements;
}

/**
 * Numbers worth checking. Small integers are skipped for the same reason the
 * tripwire skips them: "three things" is not a claim about the world, and
 * flagging it would bury the real disagreements.
 */
function extractSignificantNumbers(sentence: string): string[] {
  const matches = sentence.match(/\d[\d,.]*%?/g) ?? [];
  return matches.filter((raw) => {
    const value = Number.parseFloat(raw.replace(/[,%]/g, ""));
    if (!Number.isFinite(value)) return false;
    return raw.includes("%") || raw.includes(".") || value > 10;
  });
}

// ─── Revision (§11.3) ───────────────────────────────────────────────────────

/**
 * The reviser receives the current body, ONLY the sections flagged for
 * revision, the specific problem in each, the excerpt set, and the flagged
 * sentences. It returns replacement markdown for those sections only.
 *
 * Revising sections rather than regenerating the article is cheaper and
 * preserves what already passed.
 */
export async function reviseArticle(
  request: ContentRequest,
  version: ArticleVersion,
  angle: Angle | null,
  voice: BrandVoice | null,
  evaluation: Evaluation,
  excerpts: LabelledExcerpt[],
): Promise<ArticleVersion> {
  const sections = evaluation.sections_to_revise ?? [];
  const flagged = [
    ...(evaluation.unsupported_claims ?? []),
    ...(evaluation.weak_citations ?? []),
  ];

  const target = sections.length > 0 ? sections : inferSectionsFromComputed(evaluation, version);

  const result = await callText({
    context: { requestId: request.id, step: "revise", purpose: "revise the flagged sections" },
    model: MODELS.revision,
    system: [
      {
        text:
          "You revise specific sections of an article that has already been written and " +
          "evaluated. You do not rewrite the whole piece, and you do not touch sections you " +
          "were not asked about.\n\n" +
          "Return ONLY the replacement sections, each starting with its H2 heading exactly " +
          "as given. No preamble, no explanation, no code fence.\n\n" +
          "Every factual sentence still needs its citation marker, using only the excerpt " +
          "labels supplied. A claim you cannot support from these excerpts must be removed " +
          "rather than left uncited.",
        cache: true,
      },
      ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
    ],
    prompt: buildRevisionPrompt(version, target, flagged, evaluation, excerpts),
    maxTokens: MAX_TOKENS.revision,
    temperature: 1,
  });

  const revisedBody = spliceSections(version.body_md, result.value);

  const claim = await buildClaimMap({
    body: revisedBody,
    excerpts,
    requestId: request.id,
    step: "revise",
  });

  return saveVersion({
    request,
    angle,
    title: version.title,
    metaDescription: version.meta_description,
    body: revisedBody,
    primaryKeyword: version.primary_keyword ?? "",
    secondaryKeywords: version.secondary_keywords ?? [],
    claimMap: claim.claimMap,
    linkTargets: version.link_targets,
    excerptIds: excerpts.map((e) => e.excerptId),
    origin: "revision",
    parentVersionId: version.id,
  });
}

/** When the judge named no sections but a computed check failed, revise all. */
function inferSectionsFromComputed(
  evaluation: Evaluation,
  version: ArticleVersion,
): { heading: string; problem: string }[] {
  const problems: string[] = [];
  const computed = evaluation.computed;

  if (computed && !computed.sourceGrounding.passed) {
    problems.push(
      `Only ${computed.sourceGrounding.markedSentences} of ${computed.sourceGrounding.factualSentences} factual sentences carry a citation, and ${computed.sourceGrounding.unsupportedCount} cite an excerpt that does not support them.`,
    );
  }
  if (computed && !computed.seoFit.passed) {
    problems.push("An SEO requirement is failing — see the computed results below.");
  }
  if (computed && computed.bannedPhrases.length > 0) {
    problems.push(`Remove these banned phrases: ${computed.bannedPhrases.join(", ")}.`);
  }

  const headings = (version.headings ?? []).filter((h) => h.level === 2);
  return headings.map((h) => ({ heading: h.text, problem: problems.join(" ") }));
}

function buildRevisionPrompt(
  version: ArticleVersion,
  sections: { heading: string; problem: string }[],
  flagged: ClaimMapEntry[],
  evaluation: Evaluation,
  excerpts: LabelledExcerpt[],
): string {
  const parts = [
    `── Sections to revise ──`,
    sections.map((s) => `## ${s.heading}\nProblem: ${s.problem}`).join("\n\n"),
    ``,
  ];

  if (flagged.length > 0) {
    parts.push(
      `── Sentences flagged as unsupported or weakly supported ──`,
      `Each of these either cites nothing, or cites an excerpt that does not actually`,
      `support it. Fix by citing correctly, or by removing the claim.`,
      ``,
      flagged.slice(0, 15).map((f) => `- "${f.sentence}"${f.labels.length ? ` (cites ${f.labels.join(", ")})` : " (no citation)"}`).join("\n"),
      ``,
    );
  }

  if (evaluation.recommended_changes) {
    parts.push(`── The editor's recommendation ──`, evaluation.recommended_changes, ``);
  }

  parts.push(
    `── The current article ──`,
    ``,
    version.body_md,
    ``,
    `── Source excerpts ──`,
    `The only material you may write from.`,
    ``,
    excerpts.map((e) => `[${e.label}] ${e.text}`).join("\n\n"),
    ``,
    `Return the replacement sections now.`,
  );

  return parts.join("\n");
}

/**
 * Splices replacement sections into the body by H2 heading, leaving everything
 * else byte-identical. Preserving what already passed is the point (§11.3).
 */
export function spliceSections(original: string, replacements: string): string {
  const blocks = splitByH2(replacements);
  if (blocks.size === 0) return original;

  const lines = original.split("\n");
  const output: string[] = [];

  let skipping = false;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    const heading = !inFence ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;

    if (heading) {
      const key = normaliseHeading(heading[1]!);
      const replacement = blocks.get(key);

      if (replacement) {
        output.push(replacement.trimEnd(), "");
        skipping = true;
        blocks.delete(key);
        continue;
      }
      skipping = false;
    } else if (!inFence && /^#\s+/.test(line)) {
      // An H1 ends any section being replaced.
      skipping = false;
    }

    if (!skipping) output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function splitByH2(markdown: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = markdown.split("\n");

  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (heading !== null) blocks.set(normaliseHeading(heading), buffer.join("\n").trimEnd());
    buffer = [];
  };

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!;
      buffer = [line];
      continue;
    }
    if (heading !== null) buffer.push(line);
  }

  flush();
  return blocks;
}

function normaliseHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Human edits re-run the computed checks, including grounding (§11.4). */
export function countFactualSentencesInEdit(body: string): number {
  return segmentSentences(stripMarkdown(body)).length;
}
