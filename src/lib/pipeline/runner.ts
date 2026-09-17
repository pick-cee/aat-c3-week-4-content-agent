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
import { assignSlug, draftArticle, selectExcerptsForDrafting } from "./drafting";
import { CHECKER_VERSION, evaluateArticle, reviseArticle } from "./evaluation";
import { adaptChannel } from "./adaptation";
import { findImageCandidates } from "./images";
import { prepareMissingChannels } from "./channel-preparation";
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

import { withExecution, assertExecutionActive, executionLeaseId } from "./execution";
import { isRetryableError, PermanentPipelineError } from "./errors";
import { env } from "@/lib/env";
export interface RunnerResult {
  advanced: boolean; requestId: string; from: RequestStatus; to: RequestStatus;
  step: PipelineStep | null; message: string; more: boolean;
  retryAfterMs?: number; attempt?: { current: number; of: number } | null;
}
const RUNNING = new Set<RequestStatus>(["researching","drafting","evaluating","revising","adapting"]);
export function willRetryAfterFailure(status: RequestStatus): boolean { return RUNNING.has(status); }

export async function runStep(requestId?: string): Promise<RunnerResult> {
  const db = serviceClient();
  const leaseId = randomToken(12);
  // There is exactly one claim, including for scheduler-selected work.
  const claim = requestId
    ? await db.rpc("claim_request_lease", { p_request_id: requestId, p_lease_id: leaseId, p_lease_secs: RUNNER_LEASE_SECONDS })
    : await db.rpc("claim_next_runnable_request", { p_lease_id: leaseId, p_lease_secs: RUNNER_LEASE_SECONDS });
  if (claim.error) throw new Error("Could not claim work: " + claim.error.message);
  const request = (Array.isArray(claim.data) ? claim.data[0] : claim.data) as ContentRequest | undefined;
  if (!request?.id) {
    let status: RequestStatus = "draft";
    if (requestId) {
      const { data, error } = await db.from(table("content_requests")).select("status, deleted_at")
        .eq("id",requestId).maybeSingle();
      if (error) throw new Error("Could not read request progress: " + error.message);
      if (data && !data.deleted_at) status = data.status;
    }
    return { advanced: false, requestId: requestId ?? "", from: status, to: status, step: null,
      message: RUNNING.has(status) ? "Work is running in the background." : "No work is waiting.",
      more: RUNNING.has(status), retryAfterMs: 3_000 };
  }
  let leaseLost = false;
  const assertActive = async () => {
    if (leaseLost) throw new PermanentPipelineError("This worker no longer owns the request.");
    const { data, error } = await db.from(table("content_requests"))
      .select("status, deleted_at, runner_lease_id").eq("id", request.id).single();
    if (error) throw new Error("Could not verify the worker lease: " + error.message);
    if (data.runner_lease_id !== leaseId || data.deleted_at || !RUNNING.has(data.status)) {
      leaseLost = true;
      throw new PermanentPipelineError("The request was stopped or taken over by another worker.");
    }
  };
  const heartbeat = setInterval(() => {
    void db.rpc("renew_request_lease", { p_request_id: request.id, p_lease_id: leaseId,
      p_lease_secs: RUNNER_LEASE_SECONDS }).then(({ data, error }) => {
        if (error || data !== true) leaseLost = true;
      }, () => { leaseLost = true; });
  }, 20_000);
  try {
    return await withExecution(assertActive, async () => {
      try {
        if (request.step_attempts > MAX_STEP_ATTEMPTS) {
          throw new PermanentPipelineError("This step was interrupted repeatedly. Saved work is intact. Check worker health before retrying.");
        }
        const result = await advance(request);
        return { ...result, advanced: true, requestId: request.id, from: request.status };
      } catch (error) {
        // Cancellation wins. A late provider response cannot resurrect it.
        await assertActive();
        const to = await handleStepFailure(request, error);
        const more = willRetryAfterFailure(to);
        return { advanced: true, requestId: request.id, from: request.status, to,
          step: request.current_step, message: error instanceof Error ? error.message : String(error),
          more, retryAfterMs: more ? retryDelay(request.step_attempts) : undefined,
          attempt: more ? { current: request.step_attempts, of: MAX_STEP_ATTEMPTS } : null };
      }
    }, leaseId);
  } finally {
    clearInterval(heartbeat);
    // Persist success/failure BEFORE releasing, so another worker never starts
    // on the stale state while this worker is still recording its outcome.
    const { error } = await db.rpc("release_request_lease", { p_request_id: request.id, p_lease_id: leaseId });
    if (error) console.error("[runner] lease release failed", error.message);
  }
}
function retryDelay(attempt: number) { return Math.min(60_000, 10_000 * 2 ** Math.max(0, attempt - 1)); }
async function handleStepFailure(request: ContentRequest, error: unknown): Promise<RequestStatus> {
  const budget = error instanceof BudgetExceededError;
  const retry = !budget && isRetryableError(error) && request.step_attempts < MAX_STEP_ATTEMPTS;
  const status = budget ? "budget_exceeded" : retry ? request.status : "failed";
  const message = error instanceof Error ? error.message : String(error);
  const { error: writeError } = await serviceClient().from(table("content_requests")).update({
    status, failure_reason: message, failed_step: request.current_step,
    failure_detail: { attempts: request.step_attempts, retryable: retry,
      ...(budget ? { spentCents: error.spentCents, wouldSpendCents: error.wouldSpendCents, budgetCents: error.budgetCents } : {}) },
    retry_after: retry ? new Date(Date.now() + retryDelay(request.step_attempts)).toISOString() : null,
  }).eq("id",request.id).eq("runner_lease_id",request.runner_lease_id!).neq("status","cancelled");
  if (writeError) throw new Error("Could not save the step failure: " + writeError.message);
  await (retry ? logWarn : logError)(retry ? message + " A retry is scheduled." : message,
    { requestId: request.id, step: request.current_step });
  if (!retry) await notifyTerminalFailure(request.id, status, message).catch(() => undefined);
  return status;
}

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
        ? `${computed.factualConsistency.numberDisagreements} figure(s) could not be matched to the cited source`
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
      return {
        to: request.status,
        step: null,
        message: `Nothing for the runner to do while the request is ${request.status}.`,
        more: false,
      };
  }
}


async function advanceResearch(request: ContentRequest): Promise<Advance> {
  const db = serviceClient();
  const step = (request.current_step as PipelineStep) ?? "discover";

  if (step === "discover") {
    const result = await stepDiscover(request);

    if (result.outcome === "no_sources_found") {
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
      await setStatus(request.id, "researching", step);
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
      await setStatus(request.id, "researching", step);
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

  const plan = await planAngles(request, voice, digest, request.replan_note ?? undefined);
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
  const { voice, angle, version } = await loadContext(request);

  if (!angle) {
    throw new Error("No angle was chosen, so there is nothing to draft.");
  }

  if (version?.angle_id === angle.id) {
    if (!request.slug) await assignSlug(request.id, version.title);
    await setStatus(request.id, "evaluating", "evaluate");
    return { to: "evaluating", step: "evaluate", message: "Saved draft recovered. Checking it now.", more: true };
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

  const saved = await serviceClient().from(table("evaluations")).select("*")
    .eq("article_version_id", version.id).neq("status", "not_evaluated").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (saved.error) throw new Error(saved.error.message);
  const previous = saved.data as unknown as import("@/lib/db/types").Evaluation | null;
  const [checked] = await Promise.allSettled([
    previous?.computed?.checkerVersion === CHECKER_VERSION ? Promise.resolve(previous) : evaluateArticle({
    request,
    version,
    angle,
    voice,
    excerpts,
    allowedUrls,
    channelsProduced: 0,
    previousEvaluation: previous,
  }),
    // Free, bounded image discovery runs alongside checks, including drafts needing correction.
    findImageCandidates(request, version),
  ]);
  if (checked.status === "rejected") throw checked.reason;
  const evaluation = checked.value;
  if (evaluation.status === "not_evaluated") {
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
  if (version.origin === "human_edit") {
    await setStatus(request.id, "needs_human", "evaluate", { failure_reason: "Your edit is saved. Some checks need review; accept it with a note, edit it again, or explicitly request a revision." });
    return { to: "needs_human", step: "evaluate", message: "Your edit needs review.", more: false };
  }
  if (request.revision_rounds >= MAX_REVISION_ROUNDS) {

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

  await setStatus(request.id, "revising", "revise", { revision_parent_id: version.id });
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

  if (version.origin === "revision" && version.parent_version_id === request.revision_parent_id) {
    await setStatus(request.id, "evaluating", "evaluate", { revision_rounds: request.revision_rounds + 1 });
    return { to: "evaluating", step: "evaluate", message: "Saved revision recovered.", more: true };
  }
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

  await setStatus(request.id, "evaluating", "evaluate", { revision_rounds: request.revision_rounds + 1 });

  return {
    to: "evaluating",
    step: "evaluate",
    message: `Revision ${request.revision_rounds + 1} written. Re-evaluating.`,
    more: true,
  };
}

async function advanceAdapting(request: ContentRequest): Promise<Advance> {
  const { voice, version } = await loadContext(request);
  if (!version) throw new PermanentPipelineError("There is no article to adapt.");
  const { data, error } = await serviceClient().from(table("channel_outputs"))
    .select("channel, status").eq("article_version_id", version.id);
  if (error) throw new Error(error.message);
  await prepareMissingChannels(request.channels, (data ?? []).map(o => o.channel), channel =>
    adaptChannel(request, version, voice, channel, request.slug ? env.app.url + "/a/" + request.slug : null));
  // Image candidates were prepared alongside evaluation; selection is optional at review.
  await setStatus(request.id, "content_review", "adapt");
  return { to: "content_review", step: "adapt", message: "Your content is ready to review.", more: false };
}

interface StepContext {
  voice: BrandVoice | null;
  angle: Angle | null;
  version: ArticleVersion | null;
  excerpts: LabelledExcerpt[];
  allowedUrls: string[];
}


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

  for (const result of [voiceResult, angleResult, versionResult]) { if (result.error) throw new Error("Could not load pipeline context: " + result.error.message); }
  const version = (versionResult.data as unknown as ArticleVersion | null) ?? null;

  const { data: sources, error: sourceError } = await db
    .from(table("sources"))
    .select("id, title, url, site_name, published_at, included, fetch_status")
    .eq("request_id", request.id);

  if (sourceError) throw new Error("Could not load sources: " + sourceError.message);
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
    const { data: rows, error: excerptError } = await db
      .from(table("excerpts"))
      .select("id, source_id, text, heading_path, ordinal, embedding")
      .in("id", version.excerpt_ids_used);
    if (excerptError || rows?.length !== version.excerpt_ids_used.length) throw new PermanentPipelineError("The saved source ledger is incomplete. Restore the source excerpts before continuing.");
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
  await assertExecutionActive();
  let update = serviceClient()
    .from(table("content_requests"))
    .update({ status, current_step: step, step_attempts: 0, retry_after: null, failure_reason: null, failure_detail: null, ...extra })
    .eq("id", requestId).neq("status", "cancelled").is("deleted_at", null);
  const leaseId = executionLeaseId();
  if (leaseId) update = update.eq("runner_lease_id", leaseId);
  const { data, error } = await update.select("id").maybeSingle();
  if (error || !data) throw new Error("Could not save pipeline progress: " + (error?.message ?? "The request changed or its lease was lost."));

  await logInfo(`→ ${status}${step ? ` (${stepLabel(step)})` : ""}`, {
    requestId,
    step,
  });
}
