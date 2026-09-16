"use server";

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

/**
 * Server actions for intake and the two human gates.
 *
 * Every one of these starts by resolving the caller's profile and checking
 * their role. The UI is not a security boundary (§14.3); it decides what to
 * show, and these decide what may happen.
 */

export interface ActionResult<T = void> {
  ok: boolean;
  error?: string;
  data?: T;
}

// ─── Intake (§6) ────────────────────────────────────────────────────────────

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
  /** Carried from the form so a double-click creates one request (§5.3). */
  submitToken: string;
}

export async function createRequest(
  input: CreateRequestInput,
): Promise<ActionResult<{ id: string }>> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in to create a request." };

  // ── Validation before anything is spent (§6) ──

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

  // A malformed URL is rejected at submit, not discovered as a fetch failure
  // three steps later (§6).
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

  // Deduplicate before insert, so two spellings of one article do not both
  // become rows (§5.4).
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

  // ── Rate limits, which fail CLOSED (§18.4) ──

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

  // ── The monthly cap (§18.4) ──

  const { data: spend } = await serviceClient().rpc("read_counter", {
    p_scope: "global",
    p_scope_key: "all",
    p_window: "month",
    p_metric: "cents_spent",
  });

  if (typeof spend === "number" && spend >= env.limits.monthlyCapCents) {
    return {
      ok: false,
      error:
        `The monthly spend cap of ${formatCents(env.limits.monthlyCapCents)} has been reached. ` +
        `Requests already running will finish.`,
    };
  }

  // ── The estimate, shown before research starts (§6) ──

  const estimate = estimateRequestCost(deduped.length, channels.length);

  /**
   * The demo cap is real, but it must not be applied silently.
   *
   * A request created with $1.20 was clamped to the $0.60 demo ceiling without
   * a word, and then stopped mid-pipeline saying the budget was reached. The
   * person had set a budget that would have covered it; the system quietly
   * replaced their number with a smaller one and later blamed the budget.
   *
   * The cap still holds. It is now refused and explained rather than applied
   * behind the user's back.
   */
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
    // The unique constraint on submit_token doing its job: a double-click
    // makes one request, not two (§5.3).
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

  revalidatePath("/");
  return { ok: true, data: { id: data.id as string } };
}

/** A fresh token per form render. The uniqueness is enforced in the database. */
export async function newSubmitToken(): Promise<string> {
  return randomToken(16);
}

// ─── Gate one: sources and angle (§14.1) ────────────────────────────────────

export async function setSourceIncluded(
  requestId: string,
  sourceId: string,
  included: boolean,
  reason?: string,
): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();

  const { error } = await db
    .from(table("sources"))
    .update({
      included,
      excluded_by: included ? null : profile.id,
      excluded_reason: included ? null : (reason ?? "Excluded at review"),
    })
    .eq("id", sourceId)
    .eq("request_id", requestId);

  if (error) return { ok: false, error: error.message };

  // Excluding a source after angles exist invalidates any angle that used it.
  // The card greys out with the reason rather than silently continuing on a
  // foundation that was just removed (§14.1).
  if (!included) await invalidateAnglesUsing(requestId, sourceId);

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

async function invalidateAnglesUsing(requestId: string, sourceId: string): Promise<void> {
  const db = serviceClient();

  const { data: excerpts } = await db.from(table("excerpts")).select("id").eq("source_id", sourceId);

  const excerptIds = new Set((excerpts ?? []).map((e) => e.id as string));
  if (excerptIds.size === 0) return;

  const { data: angles } = await db
    .from(table("angles"))
    .select("id, excerpt_ids")
    .eq("request_id", requestId)
    .eq("invalidated", false);

  let invalidated = 0;

  for (const angle of angles ?? []) {
    const used = (angle.excerpt_ids as string[]) ?? [];
    if (!used.some((id) => excerptIds.has(id))) continue;

    await db
      .from(table("angles"))
      .update({
        invalidated: true,
        invalidated_reason:
          "This angle drew on a source you removed, so it no longer rests on the material it was planned from.",
      })
      .eq("id", angle.id as string);
    invalidated++;
  }

  if (invalidated > 0) {
    await logInfo(
      `A source was excluded, which invalidated ${invalidated} angle(s).`,
      { requestId, step: "plan" },
    );
  }
}

/** Re-plan with a note. Every re-plan costs money and the UI shows it (§14.1). */
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

  try {
    const { data: voice } = await db
      .from(table("brand_voices"))
      .select("*")
      .eq("id", request.brand_voice_id ?? "")
      .maybeSingle();

    const digest = await buildSourceDigest(requestId);
    if (digest.length === 0) {
      return { ok: false, error: "There are no included sources left to plan from." };
    }

    const plan = await planAngles(request, voice as never, digest, note);
    await saveAngles(requestId, plan.angles, await excerptLabelMap(requestId));

    await db
      .from(table("content_requests"))
      .update({ replans: request.replans + 1 })
      .eq("id", requestId);

    await logInfo(`Re-planned the angles. Note: ${note}`, {
      requestId,
      step: "plan",
      actorId: profile.id,
    });

    revalidatePath(`/requests/${requestId}`);
    return { ok: true, data: { replans: request.replans + 1 } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The re-plan could not be completed.",
    };
  }
}

export async function chooseAngle(requestId: string, angleId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();

  const { data: angle } = await db
    .from(table("angles"))
    .select("id, invalidated")
    .eq("id", angleId)
    .eq("request_id", requestId)
    .maybeSingle();

  if (!angle) return { ok: false, error: "That angle no longer exists." };
  if (angle.invalidated) {
    return {
      ok: false,
      error: "That angle relied on a source you removed. Re-plan before choosing.",
    };
  }

  // The partial unique index allows only one chosen angle per request, so the
  // previous choice has to be cleared first.
  await db.from(table("angles")).update({ chosen: false }).eq("request_id", requestId);

  const { error } = await db.from(table("angles")).update({ chosen: true }).eq("id", angleId);
  if (error) return { ok: false, error: error.message };

  await db
    .from(table("content_requests"))
    .update({ status: "drafting", current_step: "draft", step_attempts: 0 })
    .eq("id", requestId);

  await logInfo("Angle chosen. Drafting next.", {
    requestId,
    step: "draft",
    actorId: profile.id,
  });

  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

/** Mirrors buildSourceDigest's numbering exactly. */
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

// ─── Cancel, retry, budget ──────────────────────────────────────────────────

export async function cancelRequest(requestId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();

  await db
    .from(table("content_requests"))
    .update({ status: "cancelled", current_step: null })
    .eq("id", requestId);

  // Anything already queued stops too; cancelling a request that still posts
  // would be the worst kind of surprise.
  await db
    .from(table("publish_queue"))
    .update({ status: "cancelled" })
    .eq("request_id", requestId)
    .in("status", ["queued", "blocked_not_connected"]);

  await logInfo("Request cancelled.", { requestId, actorId: profile.id });

  revalidatePath("/");
  revalidatePath(`/requests/${requestId}`);
  return { ok: true };
}

/**
 * Deletes a request and everything under it.
 *
 * Distinct from cancelling: cancelling keeps the record, which is right for
 * something that ran and then stopped. Deleting is for a request that should
 * not exist — a typo, a test, a duplicate — where keeping it is just clutter
 * on the dashboard.
 *
 * Refused once anything has been published, because deleting the record of
 * something that went out to real people destroys the audit trail for it. The
 * cascade on `content_requests` removes the sources, excerpts, versions,
 * evaluations, channel outputs and queue rows with it.
 */
export async function deleteRequest(requestId: string): Promise<ActionResult> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  const db = serviceClient();

  const { data: row } = await db
    .from(table("content_requests"))
    .select("status, created_by")
    .eq("id", requestId)
    .maybeSingle();

  if (!row) return { ok: false, error: "That request no longer exists." };

  // Anything that reached a real audience keeps its record.
  const { data: published } = await db
    .from(table("publish_queue"))
    .select("id")
    .eq("request_id", requestId)
    .in("status", ["published", "posted_manually", "partially_delivered", "publishing"])
    .limit(1);

  if (published && published.length > 0) {
    return {
      ok: false,
      error:
        "This request has content that went out, so it cannot be deleted, that record is " +
        "the only proof of what was published. Cancel it instead.",
    };
  }

  /**
   * Soft delete. The row stays; it is hidden.
   *
   * A hard delete cascaded to `model_calls` and took the costs with it, so
   * "Spent this month" read $0 after clearing out a few drafts even though the
   * money had genuinely left the account. Money spent is a fact about the
   * past — no later action makes it untrue, and a cost report a delete can
   * rewrite is not a report.
   *
   * It is recoverable from the recycle bin, and `deleted_at` is what every
   * list filters on.
   */
  const { error } = await db
    .from(table("content_requests"))
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", requestId)
    .is("deleted_at", null);

  if (error) return { ok: false, error: `Could not delete it: ${error.message}` };

  await logInfo(
    `Moved a request that was ${row.status} to the recycle bin. Its costs still count ` +
      `towards this month's spend.`,
    { requestId, actorId: profile.id },
  );

  revalidatePath("/");
  revalidatePath("/recycle-bin");
  return { ok: true };
}

/** Puts a soft-deleted request back on the dashboard. */
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

/**
 * Permanent delete, from the recycle bin only.
 *
 * The spend is copied to `retained_spend` first, so emptying the bin still
 * cannot make a month's costs understate what was actually spent. This is the
 * only path that removes a request row.
 */
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

  // Preserve the spend before the cascade removes the model_calls rows.
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

  // No request_id: the row it would reference is gone.
  await logInfo(
    `Permanently deleted a request. Its costs were kept in the monthly total.`,
    { actorId: profile.id, detail: { deletedRequestId: requestId } },
  );

  revalidatePath("/");
  revalidatePath("/recycle-bin");
  return { ok: true };
}

/**
 * Retry is offered only where retrying could help (§17), so this resets the
 * attempt counter and resumes FROM THE FAILED STEP rather than the beginning.
 */
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

  await db
    .from(table("content_requests"))
    .update({
      status: statusForStep(step),
      current_step: step,
      step_attempts: 0,
      failure_reason: null,
      failure_detail: null,
      failed_step: null,
    })
    .eq("id", requestId);

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

/** Raises the budget on a request that stopped at `budget_exceeded` (§18.4). */
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
    .select("actual_cost_cents, budget_cents")
    .eq("id", requestId)
    .single();

  if (!row) return { ok: false, error: "That request no longer exists." };

  const spent = row.actual_cost_cents as number;
  if (newBudgetCents <= spent) {
    return {
      ok: false,
      error: `The new budget must be above what has already been spent (${formatCents(spent)}).`,
    };
  }

  await db.from(table("content_requests")).update({ budget_cents: newBudgetCents }).eq("id", requestId);

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
