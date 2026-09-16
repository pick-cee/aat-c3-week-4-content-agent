import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/log";
import { randomToken } from "@/lib/crypto";
import { BudgetExceededError } from "@/lib/cost";
import {
  assessMaterial,
  assessResearch,
  stepChunkEmbed,
  stepDiscover,
  stepFetch,
  stepScore,
} from "./research";
import { buildSourceDigest, planAngles, saveAngles } from "./planning";
import { draftArticle, selectExcerptsForDrafting } from "./drafting";
import { evaluateArticle, reviseArticle } from "./evaluation";
import { adaptAllChannels } from "./adaptation";
import { findImageCandidates } from "./images";
import { labelExcerpts, type LabelledExcerpt } from "./grounding";
import { notifyTerminalFailure } from "@/lib/notify";
import {
  MAX_STEP_ATTEMPTS,
  RUNNER_LEASE_SECONDS,
  MAX_REVISION_ROUNDS,
} from "@/lib/constants";
import type {
  ComputedChecks,
  Angle,
  ArticleVersion,
  BrandVoice,
  ContentRequest,
  PipelineStep,
  RequestStatus,
} from "@/lib/db/types";

/**
 * The step runner. DESIGN.md §3.1.
 *
 * "No step runs inside the user's request. POST /api/runner advances ONE
 * request by exactly ONE step and returns."
 *
 * Driven by the client polling while a user is watching, and by the release
 * cron as a safety net when nobody is. Two runners never process the same
 * request: work is claimed with a conditional lease update, and no row
 * returned means another runner holds it.
 */

export interface RunnerResult {
  advanced: boolean;
  requestId: string;
  from: RequestStatus;
  to: RequestStatus;
  step: PipelineStep | null;
  message: string;
  /** True while more work remains, so the caller should poll again. */
  more: boolean;
  /**
   * Set only when the last attempt failed and another is coming. The UI shows
   * the count, because a retry the person cannot see is indistinguishable from
   * a hang.
   */
  attempt?: { current: number; of: number } | null;
}

/**
 * Advances one request by one step.
 *
 * Returns `advanced: false` without doing anything if another runner holds the
 * lease — that is a normal outcome, not an error (§3.1).
 */
export async function runStep(requestId: string): Promise<RunnerResult> {
  const db = serviceClient();
  const leaseId = randomToken(12);

  const { data: claimed, error: claimError } = await db.rpc("claim_request_lease", {
    p_request_id: requestId,
    p_lease_id: leaseId,
    p_lease_secs: RUNNER_LEASE_SECONDS,
  });

  /**
   * No row means another runner holds it and this invocation does nothing.
   *
   * `claim_request_lease` returns a scalar composite, so a failed claim comes
   * back as an OBJECT with every field null rather than as nothing. Checking
   * the id is what makes the difference visible: a plain truthiness test on
   * the object passes, which is how the publish worker ended up logging
   * "channel_output <NULL> does not exist" on every empty sweep.
   */
  const claimedRow = claimed as { id?: string } | null;
  if (claimError || !claimedRow?.id) {
    return {
      advanced: false,
      requestId,
      from: "draft",
      to: "draft",
      step: null,
      message: "Another worker is already advancing this request.",
      more: true,
    };
  }

  const request = claimed as unknown as ContentRequest;
  const from = request.status;

  try {
    const result = await advance(request);

    await db.rpc("release_request_lease", {
      p_request_id: requestId,
      p_lease_id: leaseId,
    });

    return { ...result, advanced: true, requestId, from };
  } catch (err) {
    await db.rpc("release_request_lease", {
      p_request_id: requestId,
      p_lease_id: leaseId,
    });

    const to = await handleStepFailure(request, err);

    /**
     * `more` decides whether the client polls again, so it has to mean "a
     * retry is actually coming", not "something went wrong".
     *
     * This returned `more: false` for every failure, including the retryable
     * ones. The runner wrote "Trying again (attempt 1 of 3)" to the log and
     * the poller — the only thing that performs that retry while someone is
     * watching — stopped on the same response. The retry never happened. The
     * request sat at `evaluating` looking busy, forever.
     *
     * A request left in a running state is one the runner intends to pick up
     * again; a terminal state is not. Saying so honestly is what makes the
     * retry real.
     */
    const willRetry = willRetryAfterFailure(to);

    return {
      advanced: true,
      requestId,
      from,
      to,
      step: (request.current_step as PipelineStep) ?? null,
      message: err instanceof Error ? err.message : String(err),
      more: willRetry,
      attempt: willRetry
        ? { current: request.step_attempts + 1, of: MAX_STEP_ATTEMPTS }
        : null,
    };
  }
}

/**
 * States the runner will advance again. Anything else is terminal or waiting
 * on a person, and polling it would spin without ever changing.
 */
const RETRYING_STATUSES = new Set<RequestStatus>([
  "researching",
  "drafting",
  "evaluating",
  "revising",
  "adapting",
]);

/**
 * Whether a failure that left the request in `status` will actually be retried.
 *
 * Exported so the rule is testable directly: the bug it guards against was the
 * runner saying "trying again" while the poller stopped, and nothing in the
 * type system could catch a disagreement between those two.
 */
export function willRetryAfterFailure(status: RequestStatus): boolean {
  return RETRYING_STATUSES.has(status);
}

/**
 * Every failure sets a state naming the step, a plain-language reason, a
 * structured detail, an activity_log row, and an email if terminal (§17).
 *
 * A step that has exceeded max_step_attempts stops the request at `failed`
 * naming the step, rather than retrying forever on a schedule (§3.1).
 */
async function handleStepFailure(
  request: ContentRequest,
  err: unknown,
): Promise<RequestStatus> {
  const db = serviceClient();
  const step = (request.current_step as PipelineStep) ?? "discover";

  // Budget is its own terminal state with the work so far intact (§18.4).
  if (err instanceof BudgetExceededError) {
    await db
      .from(table("content_requests"))
      .update({
        status: "budget_exceeded",
        failed_step: step,
        failure_reason: err.message,
        failure_detail: {
          spentCents: err.spentCents,
          wouldSpendCents: err.wouldSpendCents,
          budgetCents: err.budgetCents,
        },
      })
      .eq("id", request.id);

    await logError(err.message, { requestId: request.id, step });
    await notifyTerminalFailure(request.id, "budget_exceeded", err.message);
    return "budget_exceeded";
  }

  const attempts = request.step_attempts + 1;
  const message = err instanceof Error ? err.message : String(err);

  if (attempts >= MAX_STEP_ATTEMPTS) {
    await db
      .from(table("content_requests"))
      .update({
        status: "failed",
        step_attempts: attempts,
        failed_step: step,
        failure_reason: message,
        failure_detail: { attempts, step },
      })
      .eq("id", request.id);

    await logError(
      `The ${stepLabel(step)} step failed ${attempts} times, so this request stopped there.`,
      { requestId: request.id, step, detail: { error: message } },
    );
    await notifyTerminalFailure(request.id, "failed", message);
    return "failed";
  }

  // Under the limit: record the attempt and leave the status alone so the next
  // invocation resumes from stored state rather than starting over.
  await db
    .from(table("content_requests"))
    .update({
      step_attempts: attempts,
      failure_reason: message,
      failure_detail: { attempts, step },
    })
    .eq("id", request.id);

  await logWarn(
    // Says what is actually true. The retry is real — the poller calls the
    // runner again and the step resumes from stored state — but the previous
    // wording implied something was already happening, while the retry only
    // fires on the next poll.
    `${stepLabel(step)} did not complete. Trying again (attempt ${attempts} of ${MAX_STEP_ATTEMPTS}).`,
    { requestId: request.id, step, detail: { error: message } },
  );

  return request.status;
}

/**
 * Names the computed checks that are still failing, in plain words.
 *
 * "It failed evaluation" tells a reviewer nothing they can act on. These are
 * measured facts, so they can be stated precisely.
 */
function describeFailingChecks(computed: ComputedChecks): string[] {
  const failing: string[] = [];

  if (!computed.sourceGrounding.passed) {
    failing.push(
      `only ${computed.sourceGrounding.markedSentences} of ` +
        `${computed.sourceGrounding.factualSentences} factual sentences cite a source`,
    );
  }
  if (!computed.factualConsistency.passed) {
    failing.push(
      computed.factualConsistency.numberDisagreements > 0
        ? `${computed.factualConsistency.numberDisagreements} figure(s) disagree with the source`
        : `${computed.factualConsistency.unsupportedCandidates} claim(s) carry no citation`,
    );
  }
  if (!computed.seoFit.passed) failing.push("the SEO checks");
  if (!computed.completeness.passed) {
    failing.push(
      `${computed.completeness.outlineSectionsPresent} of ` +
        `${computed.completeness.outlineSectionsExpected} planned sections are present`,
    );
  }
  if (computed.bannedPhrases.length > 0) {
    failing.push(`banned phrases: ${computed.bannedPhrases.join(", ")}`);
  }

  return failing;
}

function stepLabel(step: PipelineStep | string): string {
  switch (step) {
    case "discover": return "source discovery";
    case "fetch": return "page fetching";
    case "chunk_embed": return "source indexing";
    case "score": return "source ranking";
    case "plan": return "angle planning";
    case "draft": return "article drafting";
    case "evaluate": return "evaluation";
    case "revise": return "revision";
    case "adapt": return "channel adaptation";
    case "image": return "image selection";
    default: return String(step);
  }
}

// ─── The state machine ──────────────────────────────────────────────────────

type Advance = Omit<RunnerResult, "advanced" | "requestId" | "from">;

async function advance(request: ContentRequest): Promise<Advance> {
  switch (request.status) {
    case "researching":
      return advanceResearch(request);
    case "drafting":
      return advanceDrafting(request);
    case "evaluating":
      return advanceEvaluating(request);
    case "revising":
      return advanceRevising(request);
    case "adapting":
      return advanceAdapting(request);
    default:
      // plan_review and content_review wait for a human; terminal states are
      // done. Neither is an error.
      return {
        to: request.status,
        step: null,
        message: `Nothing for the runner to do while the request is ${request.status}.`,
        more: false,
      };
  }
}

/** Research is four sub-steps, each resumable from what is in the table. */
async function advanceResearch(request: ContentRequest): Promise<Advance> {
  const db = serviceClient();
  const step = (request.current_step as PipelineStep) ?? "discover";

  if (step === "discover") {
    const result = await stepDiscover(request);

    if (result.outcome === "no_sources_found") {
      // Not a failure and not an empty article (§7.1).
      await setStatus(request.id, "needs_human", null, {
        research_outcome: "no_sources_found",
      });
      await notifyTerminalFailure(
        request.id,
        "needs_human",
        "The search returned nothing usable for this topic.",
      );
      return {
        to: "needs_human",
        step: "discover",
        message: "No usable sources were found for this topic.",
        more: false,
      };
    }

    await setStatus(request.id, "researching", "fetch");
    return {
      to: "researching",
      step: "fetch",
      message: `Found ${result.seeded + result.discovered} sources. Reading them next.`,
      more: true,
    };
  }

  if (step === "fetch") {
    const result = await stepFetch(request);

    if (!result.complete) {
      await db.from(table("content_requests")).update({ step_attempts: 0 }).eq("id", request.id);
      return {
        to: "researching",
        step: "fetch",
        message: `Read ${result.attempted}; ${result.remaining} to go.`,
        more: true,
      };
    }

    const assessment = await assessResearch(request);
    if (!assessment.ok) {
      await setStatus(request.id, "needs_human", "fetch", {
        research_outcome: "insufficient_sources",
        failure_reason: assessment.reason ?? null,
      });
      await notifyTerminalFailure(request.id, "needs_human", assessment.reason ?? "");
      return {
        to: "needs_human",
        step: "fetch",
        message: assessment.reason ?? "Not enough sources could be read.",
        more: false,
      };
    }

    await setStatus(request.id, "researching", "chunk_embed");
    return {
      to: "researching",
      step: "chunk_embed",
      // Partial research is a valid outcome and must LOOK like one (§7.3).
      message:
        assessment.failed > 0
          ? `Read ${assessment.usable} sources; ${assessment.failed} could not be read and are listed.`
          : `Read all ${assessment.usable} sources.`,
      more: true,
    };
  }

  if (step === "chunk_embed") {
    const result = await stepChunkEmbed(request);

    if (!result.complete) {
      await db.from(table("content_requests")).update({ step_attempts: 0 }).eq("id", request.id);
      return {
        to: "researching",
        step: "chunk_embed",
        message: `Indexed a source (${result.excerptsCreated} excerpts).`,
        more: true,
      };
    }

    await setStatus(request.id, "researching", "score");
    return { to: "researching", step: "score", message: "Indexing complete.", more: true };
  }

  if (step === "score") {
    await stepScore(request);

    /**
     * The last honest moment to stop.
     *
     * Everything up to here is cheap; everything after is not. Checking
     * material AFTER indexing is what makes this reliable — `assessResearch`
     * ran on fetch status, so a page that fetched cleanly but held no article
     * still counted, and a request could reach planning with one real source
     * behind two rows. It then failed repeatedly on material that was never
     * there, which is expensive and looks like the system is broken.
     */
    const material = await assessMaterial(request);

    if (!material.ok) {
      await setStatus(request.id, "needs_human", "score", {
        research_outcome: "insufficient_material",
        failure_reason: material.reason ?? null,
      });
      await notifyTerminalFailure(request.id, "needs_human", material.reason ?? "");
      return {
        to: "needs_human",
        step: "score",
        message: material.reason ?? "There is not enough material to write from.",
        more: false,
      };
    }

    await setStatus(request.id, "researching", "plan");
    return {
      to: "researching",
      step: "plan",
      message: `Ranked the sources. ${material.sourcesWithContent} have enough material to write from.`,
      more: true,
    };
  }

  // plan — the last research step, which ends at gate one.
  const { voice } = await loadContext(request);
  const digest = await buildSourceDigest(request.id);

  if (digest.length === 0) {
    await setStatus(request.id, "needs_human", "plan", {
      research_outcome: "no_usable_excerpts",
      failure_reason: "No source produced usable excerpts to plan from.",
    });
    return {
      to: "needs_human",
      step: "plan",
      message: "No source produced usable excerpts.",
      more: false,
    };
  }

  const plan = await planAngles(request, voice, digest);
  await saveAngles(request.id, plan.angles, await excerptLabelMap(request.id));
  await setStatus(request.id, "plan_review", "plan");

  return {
    to: "plan_review",
    step: "plan",
    message: "Three angles are ready for you to choose from.",
    more: false,
  };
}

async function advanceDrafting(request: ContentRequest): Promise<Advance> {
  const { voice, angle } = await loadContext(request);

  if (!angle) {
    throw new Error("No angle was chosen, so there is nothing to draft.");
  }

  const excerpts = await selectExcerptsForDrafting(request, angle);
  if (excerpts.length === 0) {
    throw new Error(
      "No excerpts could be selected for this angle. The sources may all have been excluded.",
    );
  }

  await draftArticle(request, angle, voice, excerpts);
  await setStatus(request.id, "evaluating", "evaluate");

  return {
    to: "evaluating",
    step: "evaluate",
    message: "Draft written. Evaluating it now.",
    more: true,
  };
}

async function advanceEvaluating(request: ContentRequest): Promise<Advance> {
  const { voice, angle, version, excerpts, allowedUrls } = await loadContext(request);

  if (!version) throw new Error("There is no draft to evaluate.");

  const evaluation = await evaluateArticle({
    request,
    version,
    angle,
    voice,
    excerpts,
    allowedUrls,
    channelsProduced: 0,
  });

  // An evaluation that could not run must never be treated as a pass (§5.8).
  if (evaluation.status === "not_evaluated") {
    // The reason is kept in `evaluations.error` and the activity log for
    // whoever debugs it; what surfaces on the request is what a content
    // manager can act on. Nobody reviewing an article should have to read
    // about token limits.
    throw new Error(
      "The quality check could not complete, so the draft was not approved, " +
        "an evaluation that did not happen is not a pass. Retrying usually clears it.",
    );
  }

  if (evaluation.status === "pass") {
    await setStatus(request.id, "adapting", "adapt");
    return {
      to: "adapting",
      step: "adapt",
      message: "The draft passed evaluation. Adapting it for each channel.",
      more: true,
    };
  }

  // Two revision rounds, then needs_human. It never loops (§2.7).
  if (request.revision_rounds >= MAX_REVISION_ROUNDS) {
    /**
     * The reason is STORED, not just emailed.
     *
     * This was the one needs_human path that recorded nothing, so the request
     * page said "No reason was recorded, which is itself worth reporting" and
     * offered only Cancel, on the case where a finished draft is sitting there
     * waiting for a judgement call.
     */
    const failing = evaluation.computed
      ? describeFailingChecks(evaluation.computed)
      : [];

    await setStatus(request.id, "needs_human", "evaluate", {
      failure_reason:
        `The draft was rewritten ${MAX_REVISION_ROUNDS} times and still did not pass. ` +
        (failing.length > 0
          ? `What is still failing: ${failing.join("; ")}. `
          : "") +
        `Read it and decide: approve it as it stands, edit it yourself, or cancel.`,
      failure_detail: {
        revisionRounds: request.revision_rounds,
        evaluationStatus: evaluation.status,
        failingChecks: failing,
      },
    });
    await notifyTerminalFailure(
      request.id,
      "needs_human",
      `The draft still failed evaluation after ${MAX_REVISION_ROUNDS} revisions.`,
    );
    return {
      to: "needs_human",
      step: "evaluate",
      message: `Still failing after ${MAX_REVISION_ROUNDS} revisions. It needs a person.`,
      more: false,
    };
  }

  await setStatus(request.id, "revising", "revise");
  return {
    to: "revising",
    step: "revise",
    message: `Evaluation said "${evaluation.status}". Revising the weak sections.`,
    more: true,
  };
}

async function advanceRevising(request: ContentRequest): Promise<Advance> {
  const db = serviceClient();
  const { voice, angle, version, excerpts } = await loadContext(request);

  if (!version) throw new Error("There is no draft to revise.");

  const { data: evaluationRow } = await db
    .from(table("evaluations"))
    .select("*")
    .eq("article_version_id", version.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!evaluationRow) throw new Error("There is no evaluation to revise against.");

  await reviseArticle(
    request,
    version,
    angle,
    voice,
    evaluationRow as never,
    excerpts,
  );

  await db
    .from(table("content_requests"))
    .update({
      revision_rounds: request.revision_rounds + 1,
      status: "evaluating",
      current_step: "evaluate",
      step_attempts: 0,
    })
    .eq("id", request.id);

  return {
    to: "evaluating",
    step: "evaluate",
    message: `Revision ${request.revision_rounds + 1} written. Re-evaluating.`,
    more: true,
  };
}

async function advanceAdapting(request: ContentRequest): Promise<Advance> {
  const { voice, version } = await loadContext(request);
  if (!version) throw new Error("There is no article to adapt.");

  const results = await adaptAllChannels(request, version, voice);

  // Optional, and never blocking (§13).
  await findImageCandidates(request, version);

  await setStatus(request.id, "content_review", "adapt");

  const failed = results.filter((r) => r.formatFailed).length;
  return {
    to: "content_review",
    step: "adapt",
    message:
      failed === 0
        ? "Everything is ready for review."
        : `Ready for review. ${failed} channel(s) need attention.`,
    more: false,
  };
}

// ─── Shared loading ─────────────────────────────────────────────────────────

interface StepContext {
  voice: BrandVoice | null;
  angle: Angle | null;
  version: ArticleVersion | null;
  excerpts: LabelledExcerpt[];
  allowedUrls: string[];
}

/**
 * Loads everything a generation step needs. The excerpt set is rebuilt from
 * `excerpt_ids_used` on the version, so evaluation and revision see exactly
 * the same labelled set the draft was written from — a different set would
 * make every marker resolve differently.
 */
async function loadContext(request: ContentRequest): Promise<StepContext> {
  const db = serviceClient();

  const [voiceResult, angleResult, versionResult] = await Promise.all([
    request.brand_voice_id
      ? db.from(table("brand_voices")).select("*").eq("id", request.brand_voice_id).maybeSingle()
      : db.from(table("brand_voices")).select("*").eq("is_default", true).maybeSingle(),
    db.from(table("angles")).select("*").eq("request_id", request.id).eq("chosen", true).maybeSingle(),
    db
      .from(table("article_versions"))
      .select("*")
      .eq("request_id", request.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const version = (versionResult.data as unknown as ArticleVersion | null) ?? null;

  const { data: sources } = await db
    .from(table("sources"))
    .select("id, title, url, site_name, published_at, included, fetch_status")
    .eq("request_id", request.id);

  const sourceMap = new Map(
    (sources ?? []).map((s) => [
      s.id as string,
      {
        title: s.title as string | null,
        url: s.url as string,
        site_name: s.site_name as string | null,
        published_at: s.published_at as string | null,
      },
    ]),
  );

  let excerpts: LabelledExcerpt[] = [];

  if (version && version.excerpt_ids_used.length > 0) {
    const { data: rows } = await db
      .from(table("excerpts"))
      .select("id, source_id, text, heading_path, ordinal, embedding")
      .in("id", version.excerpt_ids_used);

    // Restored in the order the draft saw them, so E1 is still E1.
    const byId = new Map((rows ?? []).map((r) => [r.id as string, r]));
    const ordered = version.excerpt_ids_used
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));

    excerpts = labelExcerpts(
      ordered.map((r) => ({
        id: r.id as string,
        source_id: r.source_id as string,
        text: r.text as string,
        heading_path: r.heading_path as string | null,
        embedding: r.embedding,
      })),
      sourceMap,
    );
  }

  const allowedUrls = (sources ?? [])
    .filter((s) => s.included)
    .map((s) => s.url as string);

  return {
    voice: (voiceResult.data as unknown as BrandVoice | null) ?? null,
    angle: (angleResult.data as unknown as Angle | null) ?? null,
    version,
    excerpts,
    allowedUrls,
  };
}

/** Maps the E-labels planning used back to real excerpt ids. */
async function excerptLabelMap(requestId: string): Promise<Map<string, string>> {
  const db = serviceClient();

  const { data: sources } = await db
    .from(table("sources"))
    .select("id")
    .eq("request_id", requestId)
    .eq("included", true)
    .in("fetch_status", ["ok", "too_large", "redirected_offsite"])
    .order("relevance_score", { ascending: false, nullsFirst: false });

  const { data: excerpts } = await db
    .from(table("excerpts"))
    .select("id, source_id, ordinal")
    .eq("request_id", requestId)
    .order("ordinal");

  const bySource = new Map<string, string[]>();
  for (const row of excerpts ?? []) {
    const list = bySource.get(row.source_id as string) ?? [];
    list.push(row.id as string);
    bySource.set(row.source_id as string, list);
  }

  // Must mirror buildSourceDigest's numbering exactly.
  const map = new Map<string, string>();
  let index = 0;
  for (const source of sources ?? []) {
    for (const id of bySource.get(source.id as string) ?? []) {
      index++;
      map.set(`E${index}`, id);
    }
  }

  return map;
}

async function setStatus(
  requestId: string,
  status: RequestStatus,
  step: PipelineStep | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await serviceClient()
    .from(table("content_requests"))
    .update({ status, current_step: step, step_attempts: 0, ...extra })
    .eq("id", requestId);

  await logInfo(`→ ${status}${step ? ` (${stepLabel(step)})` : ""}`, {
    requestId,
    step,
  });
}
