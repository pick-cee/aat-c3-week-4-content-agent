"use server";

import { kickoffPipeline } from "@/lib/pipeline/kickoff";
import { requestInputSchema } from "@/lib/intake";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { serviceClient, currentProfile, canApprove, table } from "@/lib/db/client";
import { logInfo } from "@/lib/log";
import { randomToken } from "@/lib/crypto";
import { checkRateLimit, bumpCounter, formatCents } from "@/lib/cost";
import { estimateRequestCost } from "@/lib/pipeline/research";
import { buildSourceDigest, planAngles, saveAngles } from "@/lib/pipeline/planning";
import { canonicaliseUrl, isValidUrl } from "@/lib/text";
import { env } from "@/lib/env";
import {
  ALL_CHANNELS,
  MAX_IDEA_CHARS,
  MAX_SEED_URLS,
  MIN_IDEA_CHARS,
} from "@/lib/constants";
import type {
  ChannelName,
  ContentRequest,
  PipelineStep,
  RequestStatus,
} from "@/lib/db/types";

export interface ActionResult<T = void> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface CreateRequestInput {
  idea: string;
  targetAudience: string;
  primaryKeyword?: string;
  seedUrls: string[];
  channels: ChannelName[];
  brandVoiceId?: string;
  budgetCents: number;
  publishTarget?: string | null;
  holdInQueue: boolean;

  submitToken: string;
}

export async function createRequest(
  input: CreateRequestInput,
): Promise<ActionResult<{ id: string }>> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in to create a request." };

  const validated = requestInputSchema.safeParse(input);
  if (!validated.success) return { ok: false, error: validated.error.issues[0]?.message ?? "Check the brief fields." };
  input = validated.data;
  const idea = input.idea.trim();
  if (idea.length < MIN_IDEA_CHARS) {
    return {
      ok: false,
      error: `The idea needs at least ${MIN_IDEA_CHARS} characters so there is something to research.`,
    };
  }
  if (idea.length > MAX_IDEA_CHARS) {
    return { ok: false, error: `The idea is longer than ${MAX_IDEA_CHARS} characters.` };
  }

  const audience = input.targetAudience.trim();
  if (!audience) return { ok: false, error: "Target audience is required." };

  if (input.seedUrls.length > MAX_SEED_URLS) {
    return {
      ok: false,
      error: `At most ${MAX_SEED_URLS} source URLs, ingestion cost scales with this.`,
    };
  }
  const seedUrls: string[] = [];
  for (const [index, raw] of input.seedUrls.entries()) {
    const url = raw.trim();
    if (!url) continue;
    if (!isValidUrl(url)) {
      return {
        ok: false,
        error: `Source URL ${index + 1} is not a valid http(s) address: "${url}"`,
      };
    }
    seedUrls.push(url);
  }
  const seen = new Set<string>();
  const deduped = seedUrls.filter((url) => {
    try {
      const canonical = canonicaliseUrl(url);
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    } catch {
      return true;
    }
  });

  const channels = input.channels.filter((c) =>
    (ALL_CHANNELS as readonly string[]).includes(c),
  );
  if (channels.length === 0) return { ok: false, error: "Choose at least one channel." };

  const ip = await clientIp();

  const limits = [
    { scope: "profile" as const, key: profile.id, window: "hour" as const, limit: env.limits.requestsPerHour },
    { scope: "profile" as const, key: profile.id, window: "day" as const, limit: env.limits.requestsPerDay },
    { scope: "ip" as const, key: ip, window: "day" as const, limit: env.limits.requestsPerDay },
  ];

  for (const { scope, key, window, limit } of limits) {
    const check = await checkRateLimit(scope, key, window, "request_created", limit);
    if (!check.allowed) {
      return {
        ok: false,
        error:
          check.current === -1
            ? "The rate-limit counter could not be read, so the request was refused. Try again shortly."
            : `Rate limit reached: ${check.reason}`,
      };
    }
  }

  const { data: spendRows, error: spendError } = await serviceClient().rpc("dashboard_counts", {});
  const spend = spendRows?.[0]?.spent_month_cents;

  if (spendError || typeof spend !== "number") return { ok: false, error: "Could not check the monthly budget. Try again shortly." };
  if (spend >= env.limits.monthlyCapCents) {
    return {
      ok: false,
      error:
        `The monthly spend cap of ${formatCents(env.limits.monthlyCapCents)} has been reached. ` +
        `Saved work remains available. Further paid calls will wait until spending is available.`,
    };
  }

  const estimate = estimateRequestCost(deduped.length, channels.length);


  const demoCap = env.limits.demoBudgetCents;
  if (profile.is_demo && input.budgetCents > demoCap) {
    return {
      ok: false,
      error:
        `The demo workspace caps a request at ${formatCents(demoCap)}, and you asked for ` +
        `${formatCents(input.budgetCents)}. Lower the budget to ${formatCents(demoCap)} or ` +
        `less, or set DEMO_WORKSPACE_BUDGET_CENTS higher to raise the cap.`,
    };
  }

  const budget = input.budgetCents;

  if (estimate > budget) {
    return {
      ok: false,
      error:
        `This request is estimated at about ${formatCents(estimate)}, which is more than the ` +
        `${formatCents(budget)} budget. Raise the budget or reduce the number of sources.`,
    };
  }

  const db = serviceClient();

  const { data, error } = await db
    .from(table("content_requests"))
    .insert({
      created_by: profile.id,
      idea,
      target_audience: audience,
      primary_keyword: input.primaryKeyword?.trim() || null,
      seed_urls: deduped,
      channels,
      brand_voice_id: input.brandVoiceId ?? null,
      budget_cents: budget,
      estimated_cost_cents: estimate,
      status: "researching",
      current_step: "discover",
      submit_token: input.submitToken,
      publish_target: input.publishTarget ?? null,
      hold_in_queue: input.holdInQueue,
    })
    .select("id")
    .single();

  if (error) {
    if (error.message.includes("duplicate") && error.message.includes("submit_token")) {
      const { data: existing } = await db
        .from(table("content_requests"))
        .select("id")
        .eq("submit_token", input.submitToken)
        .maybeSingle();

      if (existing) return { ok: true, data: { id: existing.id as string } };
    }
    return { ok: false, error: `Could not create the request: ${error.message}` };
  }

  await bumpCounter("profile", profile.id, "hour", "request_created");
  await bumpCounter("profile", profile.id, "day", "request_created");
  await bumpCounter("ip", ip, "day", "request_created");

  await logInfo(`Request created. Estimated at about ${formatCents(estimate)}.`, {
    requestId: data.id as string,
    step: "discover",
    actorId: profile.id,
  });

  kickoffPipeline(data.id as string);
  revalidatePath("/");
  return { ok: true, data: { id: data.id as string } };
}

export async function newSubmitToken(): Promise<string> {
  return randomToken(16);
}

export async function setSourceIncluded(requestId: string, sourceId: string, included: boolean, reason?: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "Sign in to review sources." };
  const { error } = await serviceClient().rpc("set_content_source", { p_request_id: requestId, p_source_id: sourceId, p_actor_id: profile.id, p_included: included, p_reason: reason?.slice(0,1000) ?? null });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/requests/" + requestId);
  return { ok: true };
}

export async function replanAngles(
  requestId: string,
  note: string,
): Promise<ActionResult<{ replans: number }>> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();

  const { data: requestRow } = await db
    .from(table("content_requests"))
    .select("*")
    .eq("id", requestId)
    .single();

  const request = requestRow as unknown as ContentRequest | null;
  if (!request) return { ok: false, error: "That request no longer exists." };

  if (request.status !== "plan_review") {
    return { ok: false, error: "Angles can only be re-planned while the request is at review." };
  }

  const { error, data: changed } = await db.from(table("content_requests")).update({
    status: "researching", current_step: "plan", step_attempts: 0, retry_after: null,
    replan_note: note.trim().slice(0,2000), replans: request.replans + 1,
  }).eq("id",requestId).eq("status","plan_review").select("id").maybeSingle();
  if (error || !changed) return { ok: false, error: error?.message ?? "This request changed. Refresh it." };
  kickoffPipeline(requestId);
  revalidatePath("/requests/" + requestId);
  return { ok: true, data: { replans: request.replans + 1 } };
}

export async function chooseAngle(requestId: string, angleId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const { data, error } = await serviceClient().rpc("choose_content_angle", { p_request_id: requestId, p_angle_id: angleId });
  if (error || !data) return { ok: false, error: error?.message ?? "This angle is no longer available. Refresh the request." };
  await logInfo("Angle chosen. Writing your article.", { requestId, step: "draft", actorId: profile.id });
  kickoffPipeline(requestId);
  revalidatePath("/requests/" + requestId);
  return { ok: true };
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

export async function cancelRequest(requestId: string): Promise<ActionResult> { return stopRequest(requestId, false); }
export async function deleteRequest(requestId: string): Promise<ActionResult> { return stopRequest(requestId, true); }
async function stopRequest(requestId: string, remove: boolean): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "Sign in to change this request." };
  const { data, error } = await serviceClient().rpc("stop_content_request", { p_request_id: requestId, p_actor_id: profile.id, p_delete: remove });
  if (error || !data) return { ok: false, error: error?.message ?? "This request is no longer available." };
  await logInfo(remove ? "Request moved to the recycle bin. Pending deliveries cancelled." : "Request cancelled. In-flight deliveries may already have been sent.", { requestId, actorId: profile.id });
  revalidatePath("/"); revalidatePath("/requests/" + requestId); revalidatePath("/queue"); revalidatePath("/recycle-bin");
  return { ok: true };
}

export async function restoreRequest(requestId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();
  const { error } = await db
    .from(table("content_requests"))
    .update({ deleted_at: null, deleted_by: null })
    .eq("id", requestId)
    .not("deleted_at", "is", null);

  if (error) return { ok: false, error: `Could not restore it: ${error.message}` };

  await logInfo("Restored a request from the recycle bin.", {
    requestId,
    actorId: profile.id,
  });

  revalidatePath("/");
  revalidatePath("/recycle-bin");
  return { ok: true };
}

export async function purgeRequest(requestId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or admin can permanently delete a request." };
  }

  const db = serviceClient();

  const { data: row } = await db
    .from(table("content_requests"))
    .select("id, deleted_at, idea")
    .eq("id", requestId)
    .maybeSingle();

  if (!row) return { ok: false, error: "That request no longer exists." };
  if (!row.deleted_at) {
    return { ok: false, error: "Move it to the recycle bin first." };
  }
  const { error: keepError } = await db.rpc("retain_request_spend", {
    p_request_id: requestId,
  });

  if (keepError) {
    return {
      ok: false,
      error: `Could not preserve this request's costs, so it was not deleted: ${keepError.message}`,
    };
  }

  const { error } = await db.from(table("content_requests")).delete().eq("id", requestId);
  if (error) return { ok: false, error: `Could not delete it: ${error.message}` };
  await logInfo(
    `Permanently deleted a request. Its costs were kept in the monthly total.`,
    { actorId: profile.id, detail: { deletedRequestId: requestId } },
  );

  revalidatePath("/");
  revalidatePath("/recycle-bin");
  return { ok: true };
}

export async function retryRequest(requestId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();

  const { data: row } = await db
    .from(table("content_requests"))
    .select("*")
    .eq("id", requestId)
    .single();

  const request = row as unknown as ContentRequest | null;
  if (!request) return { ok: false, error: "That request no longer exists." };

  if (!["failed", "budget_exceeded"].includes(request.status)) {
    return { ok: false, error: "Only a failed or over-budget request can be retried." };
  }

  const step = request.failed_step ?? request.current_step;

  const { data: changed, error } = await db
    .from(table("content_requests"))
    .update({
      status: statusForStep(step),
      current_step: step,
      step_attempts: 0,
      failure_reason: null,
      failure_detail: null,
      failed_step: null,
      retry_after: null,
    })
    .eq("id", requestId).in("status", ["failed", "budget_exceeded"]).is("deleted_at", null).select("id").maybeSingle();
  if (error || !changed) return { ok: false, error: error?.message ?? "The request changed. Refresh before retrying." };

  kickoffPipeline(requestId);
  await logInfo(`Retrying from the ${step ?? "current"} step.`, {
    requestId,
    actorId: profile.id,
  });

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

function statusForStep(step: PipelineStep | null): RequestStatus {
  switch (step) {
    case "draft":
      return "drafting";
    case "evaluate":
      return "evaluating";
    case "revise":
      return "revising";
    case "adapt":
    case "image":
      return "adapting";
    default:
      return "researching";
  }
}

export async function raiseBudget(
  requestId: string,
  newBudgetCents: number,
): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };
  if (!canApprove(profile)) {
    return { ok: false, error: "Only a reviewer or admin can change a budget." };
  }

  const db = serviceClient();

  const { data: row } = await db
    .from(table("content_requests"))
    .select("actual_cost_cents, reserved_cost_cents, budget_cents")
    .eq("id", requestId)
    .single();

  if (!row) return { ok: false, error: "That request no longer exists." };

  if (!Number.isInteger(newBudgetCents) || newBudgetCents < 10 || newBudgetCents > 10_000) return { ok: false, error: "Budget must be between $0.10 and $100." };
  if (profile.is_demo && newBudgetCents > env.limits.demoBudgetCents) return { ok: false, error: "This exceeds the demo workspace budget cap." };
  const spent = Number(row.actual_cost_cents) + Number(row.reserved_cost_cents ?? 0);
  if (newBudgetCents <= spent) {
    return {
      ok: false,
      error: `The new budget must be above what has already been spent (${formatCents(spent)}).`,
    };
  }

  const { data: changed, error } = await db.from(table("content_requests")).update({ budget_cents: newBudgetCents })
    .eq("id", requestId).is("deleted_at", null).eq("budget_cents", row.budget_cents).select("id").maybeSingle();
  if (error || !changed) return { ok: false, error: error?.message ?? "The budget changed in another session. Refresh before trying again." };

  await logInfo(`Budget raised to ${formatCents(newBudgetCents)}.`, {
    requestId,
    actorId: profile.id,
  });

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

async function clientIp(): Promise<string> {
  const headerList = await headers();
  return (
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headerList.get("x-real-ip") ??
    "unknown"
  );
}
