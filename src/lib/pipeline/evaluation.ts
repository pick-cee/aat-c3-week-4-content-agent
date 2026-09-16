import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/log";
import { callStructured, callText } from "@/lib/providers/anthropic";
import { buildClaimMap, type LabelledExcerpt } from "./grounding";
import { findBannedPhrases, runSeoChecks } from "./checks";
import {
  brandVoiceBlock,
  RUBRIC_BLOCK,
  PUNCTUATION_BLOCK,
  CITATION_BLOCK,
  LINKING_BLOCK,
} from "./prompts";
import { saveVersion } from "./drafting";
import {
  MAX_TOKENS,
  MODELS,
  MAX_UNSUPPORTED_CLAIMS,
  MAX_WEAK_CITATION_RATIO,
  MIN_MARKED_SENTENCE_RATIO,
  MAX_SECTIONS_PER_REVISION,
} from "@/lib/constants";
import { segmentSentences, stripMarkdown } from "@/lib/text";
import { BudgetExceededError } from "@/lib/cost";
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
    /**
     * A LIST, not a paragraph.
     *
     * As a single string this came back as one dense block — nine separate
     * edits run together in eleven lines, which a person has to parse before
     * they can act on any of it. Discrete items can be read, ordered and
     * ticked off. The description caps the count, since structured outputs
     * reject maxItems.
     */
    recommendedChanges: {
      type: "array",
      description:
        "At most 5 changes, each one concrete action in a single sentence under 25 words. " +
        "Most important first. If the draft is fine, return an empty array.",
      items: { type: "string" },
    },
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
  recommendedChanges: string[];
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
  const numberDisagreementDetail = findNumberDisagreements(claim.claimMap, excerpts);
  const numberDisagreements = numberDisagreementDetail.length;

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
      numberDisagreementDetail,
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

  // Built once so the retry below sends exactly the same thing.
  const judgeSystem = [
    {
      text:
        "You are an editor reviewing a draft against a rubric. You did not write it and " +
        "you are not being asked to agree with whoever did.\n\n" +
        "You are given the article, the brand voice, and the results of checks that were " +
        "already computed mechanically. Those computed results are FACTS, do not " +
        "re-litigate them, and do not award a criterion you are judging on the basis of " +
        "one you are not.\n\n" +
        "Be specific. \"The tone is off\" is not useful; \"paragraph three uses three " +
        "abstractions where the voice calls for a concrete example\" is.",
      cache: true,
    },
    { text: RUBRIC_BLOCK, cache: true },
    ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
    { text: PUNCTUATION_BLOCK, cache: true },
  ];

  const judgePrompt = buildJudgePrompt(request, version, computed);

  try {
    const result = await callStructured<JudgedOutput>({
      context: { requestId: request.id, step: "evaluate", purpose: "judge the draft" },
      model: MODELS.evaluation,
      system: judgeSystem,
      // Deliberately NOT given the drafting prompt or the model's rationale:
      // it is evaluating the artefact, not agreeing with the reasoning that
      // produced it (§11.1).
      prompt: judgePrompt,
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
    /**
     * A budget refusal is not a flaky call, and retrying it is not "trying
     * harder" — the cost of the next attempt is identical and the money is
     * just as absent, so every retry is guaranteed to fail the same way.
     *
     * Rethrown so the runner sees the real type. Flattening it into
     * `not_evaluated` cost four useless attempts and told the manager
     * "retrying usually clears it" about the one condition retrying can never
     * clear.
     */
    if (err instanceof BudgetExceededError) throw err;

    /**
     * One retry before giving up.
     *
     * A single flaky judge call used to stop the whole request: the status
     * became `not_evaluated`, which can never become `pass` (§5.8), so the
     * step runner failed it and a content manager saw a stalled request over
     * something that would have worked on a second attempt.
     *
     * The rule that `not_evaluated` is not a pass is untouched. This only
     * decides how hard we try before admitting it.
     */
    try {
      const retry = await callStructured<JudgedOutput>({
        context: { requestId: request.id, step: "evaluate", purpose: "judge the draft (retry)" },
        model: MODELS.evaluation,
        system: judgeSystem,
        prompt: judgePrompt,
        schema: JUDGED_SCHEMA,
        maxTokens: MAX_TOKENS.evaluation,
      });

      judged = {
        ...retry.value,
        criteria: Object.fromEntries(
          Object.entries(retry.value.criteria ?? {}).map(([key, criterion]) => [
            key,
            { ...criterion, score: normaliseScore(criterion?.score) },
          ]),
        ) as JudgedOutput["criteria"],
      };
      usage = retry.usage;
    } catch (retryErr) {
      // The retry can run out of budget even when the first call did not.
      if (retryErr instanceof BudgetExceededError) throw retryErr;

      judgeError =
        `${err instanceof Error ? err.message : String(err)} ` +
        `(retried once: ${retryErr instanceof Error ? retryErr.message : String(retryErr)})`;
    }
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
      recommended_changes: (judged?.recommendedChanges ?? []) as never,
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
export interface NumberDisagreement {
  sentence: string;
  /** The figure that does not appear in the cited excerpt. */
  number: string;
  labels: string[];
  /** What the cited excerpt actually says, so a fix can be made from it. */
  citedText: string;
}

/**
 * Figures that do not appear in the excerpt they cite.
 *
 * This returned a COUNT and discarded everything else, so the revision prompt
 * could say "something is wrong with a number" and nothing more. The same
 * check then failed three revisions in a row, each one guessing, because the
 * model was never told which figure or what the source actually said.
 *
 * Returning the detail is what makes the defect fixable: it is one of the most
 * precisely diagnosable failures in the system.
 */
function findNumberDisagreements(
  claimMap: ClaimMapEntry[],
  excerpts: LabelledExcerpt[],
): NumberDisagreement[] {
  const byLabel = new Map(excerpts.map((e) => [e.label, e]));
  const found: NumberDisagreement[] = [];

  for (const entry of claimMap) {
    const numbers = extractSignificantNumbers(entry.sentence);
    if (numbers.length === 0) continue;

    const citedText = entry.labels
      .map((l) => byLabel.get(l)?.text ?? "")
      .join(" ");
    if (!citedText) continue;

    for (const number of numbers) {
      if (!citedTextStatesNumber(citedText, number)) {
        found.push({
          sentence: entry.sentence,
          number,
          labels: entry.labels,
          // Enough of the excerpt to correct the figure from.
          citedText: citedText.slice(0, 400),
        });
        break;
      }
    }
  }

  return found;
}

/**
 * Numbers worth checking. Small integers are skipped for the same reason the
 * tripwire skips them: "three things" is not a claim about the world, and
 * flagging it would bury the real disagreements.
 */
function extractSignificantNumbers(sentence: string): string[] {
  /**
   * Strip the machinery before looking for claims.
   *
   * `((link: text | E14))` and `[E3]` carry excerpt LABELS, not figures. The
   * old pattern pulled "14" out of a link marker and reported it as a figure
   * that disagreed with its source, which no revision could ever fix because
   * there was no figure to correct.
   */
  const prose = sentence
    .replace(/\(\(link:[^)]*\)\)/g, " ")
    .replace(/\[E\d+(?:\s*,\s*E\d+)*\]/g, " ");

  // The trailing [.,] of "38." or "38," is punctuation, not part of the value.
  /**
   * The leading `\.?` matters: markdown stripping turns "0.38" into ".38", and
   * a pattern that requires a leading digit captures "38" instead. That is a
   * different number, and comparing it against the source produced a
   * disagreement that no revision could fix.
   */
  const matches = prose.match(/\.\d+%?|\d[\d,]*(?:\.\d+)?%?/g) ?? [];

  return matches
    .map((raw) => raw.replace(/[.,]+$/, ""))
    .filter((raw) => {
      const value = Number.parseFloat(raw.replace(/[,%]/g, ""));
      if (!Number.isFinite(value)) return false;
      return raw.includes("%") || raw.includes(".") || value > 10;
    });
}

/**
 * Whether a figure appears in the text it cites.
 *
 * A literal `includes` was the second half of the bug: "0.38" does not appear
 * in an excerpt that writes ".38", "4,312" does not appear in one that writes
 * "4312", and "38%" does not appear in one that writes "38 percent". Every one
 * of those is the same number, and reporting them as disagreements sent the
 * article into revisions that could not succeed.
 *
 * Numbers are compared as VALUES. The excerpt still has to contain the figure;
 * it simply no longer has to spell it identically.
 */
function citedTextStatesNumber(citedText: string, raw: string): boolean {
  if (citedText.includes(raw)) return true;

  const target = Number.parseFloat(raw.replace(/[,%]/g, ""));
  if (!Number.isFinite(target)) return false;

  // Same pattern as extraction, so ".38" in a source is read as 0.38.
  for (const candidate of citedText.match(/\.\d+|\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const value = Number.parseFloat(candidate.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    if (value === target) return true;
    // "0.38" written as ".38", and percentages written either way.
    if (Math.abs(value - target) < 1e-9) return true;
  }

  return false;
}

/** Exposed for the unit test: both were silently manufacturing failures. */
export const extractSignificantNumbersForTest = extractSignificantNumbers;
export const citedTextStatesNumberForTest = citedTextStatesNumber;

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
  /**
   * At most two sections per invocation, whoever chose them.
   *
   * The judge can name five, and rewriting five sections of a 1,300-word
   * article produced 12,250 output tokens, hit the ceiling, retried at a
   * higher one, and took 282 seconds against a 60-second function limit.
   *
   * A step that cannot finish inside the platform's budget is a step that
   * never finishes at all, so the work is bounded here instead. Sections left
   * over are picked up on the next revision round: the runner advances one
   * step at a time and every step resumes from stored state (§3.1).
   */
  const sections = (evaluation.sections_to_revise ?? []).slice(0, MAX_SECTIONS_PER_REVISION);
  const flagged = [
    ...(evaluation.unsupported_claims ?? []),
    ...(evaluation.weak_citations ?? []),
  ];

  const target = sections.length > 0 ? sections : inferSectionsFromComputed(evaluation, version);

  /**
   * What the reviewer asked for, in their words.
   *
   * `requestRevision` stored this note in `approvals` and nothing ever read
   * it, so a person could write precise instructions and the revision would
   * proceed exactly as if they had said nothing. A human note is the best
   * information this step ever gets; it leads the prompt.
   */
  const { data: noteRow } = await serviceClient()
    .from(table("approvals"))
    .select("note, created_at")
    .eq("request_id", request.id)
    .eq("decision", "revision_requested")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const humanNote = (noteRow?.note as string | null) ?? null;

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
          "You will be shown the full article for context. Returning it back is the most " +
          "common way this step goes wrong, it wastes the revision and risks changing " +
          "sections that already passed. Your output should be considerably SHORTER than " +
          "the article you were given.\n\n" +
          "Your replacement sections are judged by exactly the same checks as the original " +
          "draft, so the rules below apply to every sentence you write.\n\n" +
          "KEEP THE LINKS. The article needs a minimum number of link markers and they live " +
          "inside the sections you are replacing. A revision that drops them fails the SEO " +
          "check even when the prose is better, which is a wasted round. Carry over every " +
          "((link: ... | E12)) marker from the section you are rewriting unless you are " +
          "removing the sentence it sits in, and write it in that exact form.",
        cache: true,
      },
      /**
       * The revision is held to the same checks as the draft, so it gets the
       * same rules.
       *
       * It previously got one sentence about citations and nothing about
       * figures or links, then was graded on all three. One request failed the
       * same figure check three rounds running, and the last attempt broke
       * `linksResolve` on a section that had already passed, because nothing
       * told it how links work.
       */
      { text: CITATION_BLOCK, cache: true },
      { text: LINKING_BLOCK, cache: true },
      ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
      { text: PUNCTUATION_BLOCK, cache: true },
    ],
    prompt: buildRevisionPrompt(version, target, flagged, evaluation, excerpts, humanNote),
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
    problems.push("An SEO requirement is failing, see the computed results below.");
  }
  if (computed && computed.bannedPhrases.length > 0) {
    problems.push(`Remove these banned phrases: ${computed.bannedPhrases.join(", ")}.`);
  }

  /**
   * At most three sections, never the whole article.
   *
   * This returned EVERY H2, so a revision with no named sections rewrote the
   * entire piece: 12,250 output tokens, a truncation retry at a higher
   * ceiling, and 282 seconds for one step. Section-scoped revision exists
   * precisely to avoid that, and the fallback was undoing it.
   *
   * The sections carrying flagged sentences are the ones that need work, so
   * they are chosen first; the opening section is the fallback when nothing
   * is flagged, because that is where an ungrounded claim usually sits.
   */
  const headings = (version.headings ?? []).filter((h) => h.level === 2);
  if (headings.length === 0) return [];

  const flaggedText = [
    ...(evaluation.unsupported_claims ?? []),
    ...(evaluation.weak_citations ?? []),
  ]
    .map((c) => c.sentence)
    .join(" ")
    .toLowerCase();

  const body = version.body_md ?? "";

  // A section is implicated when one of its own sentences was flagged.
  const implicated = headings.filter((h) => {
    const start = body.indexOf(h.text);
    if (start === -1) return false;
    const nextStarts = headings
      .map((other) => body.indexOf(other.text))
      .filter((i) => i > start);
    const end = nextStarts.length > 0 ? Math.min(...nextStarts) : body.length;
    const section = body.slice(start, end).toLowerCase();
    return flaggedText.length > 0 && section.split(/[.!?]/).some((sentence) => {
      const t = sentence.trim();
      return t.length > 40 && flaggedText.includes(t.slice(0, 40));
    });
  });

  const chosen = (implicated.length > 0 ? implicated : headings.slice(0, 1)).slice(
    0,
    MAX_SECTIONS_PER_REVISION,
  );
  return chosen.map((h) => ({ heading: h.text, problem: problems.join(" ") }));
}

function buildRevisionPrompt(
  version: ArticleVersion,
  sections: { heading: string; problem: string }[],
  flagged: ClaimMapEntry[],
  evaluation: Evaluation,
  excerpts: LabelledExcerpt[],
  humanNote: string | null,
): string {
  const parts = [];

  // A person's instruction outranks everything the checks inferred, so it is
  // the first thing read.
  if (humanNote) {
    parts.push(
      `── WHAT THE REVIEWER ASKED FOR ──`,
      `A person read this draft and asked for this specific change. It takes`,
      `priority over everything below.`,
      ``,
      humanNote,
      ``,
    );
  }

  parts.push(
    `── Sections to revise ──`,
    sections.map((s) => `## ${s.heading}\nProblem: ${s.problem}`).join("\n\n"),
    ``,
  );

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

  /**
   * The figures that disagree with their source, named exactly.
   *
   * This is the check that failed three revisions in a row on one request,
   * because the prompt said nothing about it: the model was told the article
   * needed work and left to guess which number. Given the sentence, the
   * figure and what the excerpt actually says, it is a mechanical fix.
   */
  const disagreements = evaluation.computed?.factualConsistency.numberDisagreementDetail ?? [];
  if (disagreements.length > 0) {
    parts.push(
      `── FIGURES THAT DO NOT MATCH THEIR SOURCE ──`,
      `Each of these states a number that does not appear in the excerpt it cites.`,
      `Correct the figure to match the excerpt, or remove the claim. Do not keep`,
      `the number and change the citation.`,
      ``,
      disagreements
        .slice(0, 8)
        .map(
          (d) =>
            `- The sentence: "${d.sentence}"` +
            `\n  The figure that is wrong: ${d.number}` +
            `\n  What the source says: "${d.citedText}"`,
        )
        .join("\n\n"),
      ``,
    );
  }

  const recommended = evaluation.recommended_changes ?? [];
  if (recommended.length > 0) {
    parts.push(
      `── The editor's recommendation ──`,
      recommended.map((change, i) => `${i + 1}. ${change}`).join("\n"),
      ``,
    );
  }

  parts.push(
    `── The current article, for context ──`,
    `Read it to keep your replacements consistent with the rest. Do NOT return it.`,
    ``,
    version.body_md,
    ``,
    `── Source excerpts ──`,
    `The only material you may write from.`,
    ``,
    excerpts.map((e) => `[${e.label}] ${e.text}`).join("\n\n"),
    ``,
    /**
     * Stated at the end, where the model is about to start writing.
     *
     * Sending the whole article for context invites returning the whole
     * article: a four-section revision of a 1,500-word piece came back at
     * 10,650 tokens and then hit the cap entirely. The sections are named
     * again here so the last thing read is the scope, not the article.
     */
    `── What to return ──`,
    ``,
    `ONLY these ${sections.length} section(s), each starting with its H2 heading exactly as`,
    `written above:`,
    sections.map((s) => `  ## ${s.heading}`).join("\n"),
    ``,
    `Do not return the title, the introduction, the conclusion, or any section`,
    `not in that list. Everything else is already approved and is left untouched —`,
    `returning it wastes the revision and risks changing what already passed.`,
    ``,
    `Return those sections now, and nothing else.`,
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
