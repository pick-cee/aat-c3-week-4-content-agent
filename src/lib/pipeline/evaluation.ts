import "server-only";
import { editorialFeedback } from "@/lib/editorial-feedback";
import { normaliseNumberText, NUMBER_TOKEN } from "./number-text";
import { factualRevisionTargets } from "./revision-targets";
import { preserveRevisionLinks } from "./revision-links";
import { articleSections, headingKey, OPENING_SECTION, applyRevisionPatch, REVISION_SCHEMA, type RevisionPatch } from "./revision-patch";
import { assertExecutionActive } from "./execution";
import { PermanentPipelineError } from "./errors";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn } from "@/lib/log";
import { callStructured } from "@/lib/providers/anthropic";
import { buildClaimMap, checkMarkerIntegrity, type LabelledExcerpt } from "./grounding";
import { findBannedPhrases, runSeoChecks, replaceEmDashes } from "./checks";
import {
  brandVoiceBlock,
  RUBRIC_BLOCK,
  PUNCTUATION_BLOCK,
  CITATION_BLOCK,
  LINKING_BLOCK,
} from "./prompts";
import { saveVersion, substituteLinks } from "./drafting";
import {
  MAX_TOKENS,
  MODELS,
  MAX_UNSUPPORTED_CLAIMS,
  MAX_WEAK_CITATION_RATIO,
  MIN_MARKED_SENTENCE_RATIO,
  MAX_SECTIONS_PER_REVISION,
} from "@/lib/constants";
import { segmentSentences, stripMarkdown, parseHeadings } from "@/lib/text";
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

export const CHECKER_VERSION = 2;

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

      score: {
        type: ["integer", "null"],
        description: "1 to 5, or null if you genuinely could not assess it.",
      },
      reason: { type: "string" },
    },
  };
}

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

export interface EvaluateInput {
  request: ContentRequest;
  version: ArticleVersion;
  angle: Angle | null;
  voice: BrandVoice | null;
  excerpts: LabelledExcerpt[];
  allowedUrls: string[];
  channelsProduced: number;
  previousEvaluation?: Evaluation | null;
}

export async function evaluateArticle(input: EvaluateInput): Promise<Evaluation> {
  const { request, version, angle, voice, excerpts, allowedUrls } = input;

  const claim = await buildClaimMap({
    body: version.body_md,
    excerpts,
    requestId: request.id,
    step: "evaluate",
    previous: version.claim_map as ClaimMapEntry[],
  });
  if (claim.degraded) throw new Error(claim.degradedReason ?? "Source checks are temporarily unavailable. Retry when embeddings recover.");

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
    checkerVersion: CHECKER_VERSION,
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

  let judged: JudgedOutput | null = null;
  let judgeError: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
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
        "abstractions where the voice calls for a concrete example\" is. " +
        "Keep each reason under 25 words and the complete response under 650 words. " +
        "overallNote must summarise the assessment in a useful sentence; never return template text such as 'placeholder'. Return only the rubric JSON.",
      cache: true,
    },
    { text: RUBRIC_BLOCK, cache: true },
    ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
    { text: PUNCTUATION_BLOCK, cache: true },
  ];

  const judgePrompt = buildJudgePrompt(request, version, computed);

  try {
    const previous = input.previousEvaluation;
    if (previous?.article_version_id === version.id && previous.judged &&
        ["topicRelevance", "audienceFit", "tone", "clarity"].every(key => normaliseScore(previous.judged?.[key]?.score) !== null)) {
      // Text has not changed: refresh mechanical checks without buying the same editorial review again.
      judged = { criteria: previous.judged as JudgedOutput["criteria"],
        sectionsToRevise: previous.sections_to_revise ?? [], recommendedChanges: previous.recommended_changes ?? [],
        overallStatus: previous.judge_verdict as JudgedOutput["overallStatus"], overallNote: previous.overall_note ?? "" };
    } else {
    const result = await callStructured<JudgedOutput>({
      context: { requestId: request.id, step: "evaluate", purpose: "judge the draft" },
      model: MODELS.evaluation,
      system: judgeSystem,
      prompt: judgePrompt,
      schema: JUDGED_SCHEMA,
      maxTokens: MAX_TOKENS.evaluation,
    });
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
    }
  } catch (err) {
    throw err;
  }

  const { status, overruled } = decide(computed, judged, claim);

  await assertExecutionActive();
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
      recommended_changes: (judged?.recommendedChanges ?? []).map(editorialFeedback).filter(Boolean) as never,
      overall_note: editorialFeedback(judged?.overallNote),
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

function decide(
  computed: ComputedChecks,
  judged: JudgedOutput | null,
  claim: { degraded: boolean },
): { status: EvaluationStatus; overruled: boolean } {
  if (!judged) return { status: "not_evaluated", overruled: false };

  const scores = Object.values(judged.criteria).map((c) => c.score);
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

export interface NumberDisagreement {
  sentence: string;

  number: string;
  labels: string[];

  citedText: string;
}

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
          citedText: citedText.slice(0, 400),
        });
        break;
      }
    }
  }

  return found;
}

function extractSignificantNumbers(sentence: string): string[] {

  const prose = normaliseNumberText(sentence
    .replace(/\(\(link:[^)]*\)\)/g, " ")
    .replace(/\[E\d+(?:\s*,\s*E\d+)*\]/g, " "));

  const matches = prose.match(NUMBER_TOKEN) ?? [];

  return matches
    .map((raw) => raw.replace(/[.,]+$/, ""))
    .filter((raw) => {
      const value = Number.parseFloat(raw.replace(/[,%]/g, ""));
      if (!Number.isFinite(value)) return false;
      return raw.includes("%") || raw.includes(".") || value > 10;
    });
}

function citedTextStatesNumber(citedText: string, raw: string): boolean {
  const target = Number.parseFloat(raw.replace(/[,%]/g, ""));
  if (!Number.isFinite(target)) return false;
  for (const candidate of normaliseNumberText(citedText).match(NUMBER_TOKEN) ?? []) {
    if (raw.endsWith("%") !== candidate.endsWith("%")) continue;
    const value = Number.parseFloat(candidate.replace(/[,%]/g, ""));
    if (!Number.isFinite(value)) continue;
    if (value === target) return true;
    if (Math.abs(value - target) < 1e-9) return true;
  }

  return false;
}

export const extractSignificantNumbersForTest = extractSignificantNumbers;
export const citedTextStatesNumberForTest = citedTextStatesNumber;

export async function reviseArticle(
  request: ContentRequest,
  version: ArticleVersion,
  angle: Angle | null,
  voice: BrandVoice | null,
  evaluation: Evaluation,
  excerpts: LabelledExcerpt[],
): Promise<ArticleVersion> {

  const sections = [...factualRevisionTargets(version.body_md, evaluation), ...(evaluation.sections_to_revise ?? [])];
  const flagged = evaluation.computed?.sourceGrounding.passed === false || evaluation.computed?.factualConsistency.passed === false
    ? [...(evaluation.unsupported_claims ?? []), ...(evaluation.weak_citations ?? [])] : [];

  let target = sections.length > 0 ? sections : inferSectionsFromComputed(evaluation, version);


  const { data: noteRow, error: noteError } = await serviceClient()
    .from(table("approvals"))
    .select("note, created_at")
    .eq("request_id", request.id)
    .eq("decision", "revision_requested")
    .eq("subject_type", "article").eq("subject_id", version.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (noteError) throw new Error("Could not read the reviewer's revision note: " + noteError.message);
  const humanNote = (noteRow?.note as string | null) ?? null;
  const existing = articleSections(version.body_md);
  const known = new Set(existing.map(s => headingKey(s.heading)));
  const missing = (angle?.outline ?? []).filter(s => !known.has(headingKey(s.heading)));
  const opening = existing[0]?.body ?? "";
  const seo = evaluation.computed?.seoFit;
  const openingNeedsWork = (seo && (!seo.keywordInTitle || !seo.keywordInFirst100 || !seo.exactlyOneH1)) ||
    flagged.some(claim => opening.includes(claim.sentence));
  target = humanNote
    ? [...existing.map(s => ({ heading: s.heading, problem: "Change only if necessary for the reviewer's note." })),
       ...missing.map(s => ({ heading: s.heading, problem: s.intent }))]
    : [...(openingNeedsWork ? [{ heading: OPENING_SECTION, problem: "Fix title, opening keyword placement and unsupported opening claims." }] : []),
       ...missing.map(s => ({ heading: s.heading, problem: "Add this missing outline section: " + s.intent })),
       ...target.filter(s => known.has(headingKey(s.heading)))].filter((section, index, all) =>
         all.findIndex(other => headingKey(other.heading) === headingKey(section.heading)) === index
       ).slice(0, MAX_SECTIONS_PER_REVISION);
  if (!target.length) throw new PermanentPipelineError("No safe section revision was identified. Edit the saved article or add a specific revision note.");
  const allowed = target.map(s => s.heading);
  const result = await callStructured<RevisionPatch>({
    context: { requestId: request.id, step: "revise", purpose: "revise the requested sections" },
    model: MODELS.revision,
    schema: REVISION_SCHEMA,
    system: [
      { text: "Revise only the requested parts of this source-grounded article. Return JSON sections, each with heading and markdown. " +
        "Each markdown replacement must start with its exact H2 and contain no other H2. The special 'Article opening' replacement " +
        "must contain the H1 title and introduction only, with no H2. Return at most " + MAX_SECTIONS_PER_REVISION +
        " changed sections. Preserve the rest. Keep existing verified links and citation markers. Use new ((link: anchor | E1)) markers only for supplied excerpts. " +
        "A reviewer's note takes priority over automated recommendations. Never invent evidence.", cache: true },
      { text: CITATION_BLOCK, cache: true },
      { text: LINKING_BLOCK, cache: true },
      ...(voice ? [{ text: brandVoiceBlock(voice), cache: true }] : []),
      { text: PUNCTUATION_BLOCK, cache: true },
    ],
    prompt: [
      humanNote ? "Reviewer request: " + humanNote : "Repair the failed checks with the fewest edits.",
      "Allowed sections: " + JSON.stringify(target),
      "Primary keyword: " + (version.primary_keyword ?? angle?.primary_keyword ?? ""),
      "Original brief: " + request.idea + "\nAudience: " + request.target_audience,
      "Editorial criteria and reasons: " + JSON.stringify(evaluation.judged),
      "Computed checks: " + JSON.stringify(evaluation.computed),
      "Flagged claims: " + JSON.stringify(flagged.slice(0, 15)),
      "Recommendations: " + JSON.stringify(evaluation.recommended_changes),
      "Current article:\n" + version.body_md,
      "Approved evidence:\n" + excerpts.map(e => "[" + e.label + "] " + e.text).join("\n\n"),
    ].join("\n\n"),
    maxTokens: MAX_TOKENS.revision,
    temperature: 1,
    validate: patch => {
      const revised = applyRevisionPatch(version.body_md, patch, allowed, MAX_SECTIONS_PER_REVISION);
      if (!checkMarkerIntegrity(revised, excerpts).valid) throw new PermanentPipelineError("The revision introduced unsupported citation markers. Review the saved draft.");
    },
  });
  const linked = substituteLinks(replaceEmDashes(applyRevisionPatch(version.body_md, result.value, allowed, MAX_SECTIONS_PER_REVISION)), excerpts, version.link_targets ?? []);
  const revisedBody = preserveRevisionLinks(version.body_md, linked.body, excerpts.map(excerpt => excerpt.sourceUrl));

  const claim = await buildClaimMap({
    body: revisedBody,
    excerpts,
    requestId: request.id,
    step: "revise",
    previous: version.claim_map as ClaimMapEntry[],
  });

  return saveVersion({
    request,
    angle,
    title: parseHeadings(revisedBody).find(heading => heading.level === 1)?.text ?? version.title,
    metaDescription: version.meta_description,
    body: revisedBody,
    primaryKeyword: version.primary_keyword ?? "",
    secondaryKeywords: version.secondary_keywords ?? [],
    claimMap: claim.claimMap,
    linkTargets: linked.intents,
    excerptIds: excerpts.map((e) => e.excerptId),
    origin: "revision",
    parentVersionId: version.id,
  });
}

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

export function countFactualSentencesInEdit(body: string): number {
  return segmentSentences(stripMarkdown(body)).length;
}
