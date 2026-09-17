import "server-only";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { assertExecutionActive, executionLeaseId } from "@/lib/pipeline/execution";
import { serviceClient, table } from "@/lib/db/client";
import { logError, logWarn } from "@/lib/log";
import {
  MODEL_PRICES,
  WEB_SEARCH_PRICE_PER_SEARCH,
  EMBEDDING_PRICE_PER_MTOK,
  FIRECRAWL_PRICE_PER_CREDIT,
  type ModelId,
} from "@/lib/constants";
import type { ModelCallOutcome } from "@/lib/db/types";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  webSearches?: number;
}

export function priceModelCall(model: string, usage: TokenUsage): number {
  const prices = MODEL_PRICES[model as ModelId];
  if (!prices) {
    throw new UnpricedModelError(model);
  }

  const inputCost = (usage.inputTokens / 1e6) * prices.input;
  const cacheCost = ((usage.cacheReadTokens ?? 0) / 1e6) * prices.cacheRead;
  const outputCost = (usage.outputTokens / 1e6) * prices.output;
  const searchCost = (usage.webSearches ?? 0) * WEB_SEARCH_PRICE_PER_SEARCH;

  const cacheWriteCost = ((usage.cacheCreationTokens ?? 0) / 1e6) * prices.input * 1.25;
  return (inputCost + cacheCost + cacheWriteCost + outputCost + searchCost) * 100;
}

export class UnpricedModelError extends Error {
  constructor(public readonly model: string) {
    super(
      `No price on record for model "${model}". Add it to MODEL_PRICES in ` +
        `src/lib/constants.ts and update PRICES_VERIFIED_ON.`,
    );
    this.name = "UnpricedModelError";
  }
}

export function priceEmbedding(tokens: number): number {
  return (tokens / 1e6) * EMBEDDING_PRICE_PER_MTOK * 100;
}

export function priceScrapes(credits: number): number {
  return credits * FIRECRAWL_PRICE_PER_CREDIT * 100;
}

export function estimateWorstCase(
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
  webSearches = 0,
): number {
  return priceModelCall(model, {
    inputTokens,
    outputTokens: maxOutputTokens,
    webSearches,
  });
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly spentCents: number,
    public readonly wouldSpendCents: number,
    public readonly budgetCents: number,
  ) {
    super(
      `This step needs about ${formatCents(wouldSpendCents)} and only ` +
        `${formatCents(Math.max(0, budgetCents - spentCents))} of the ` +
        `${formatCents(budgetCents)} budget is left (${formatCents(spentCents)} spent or reserved). ` +
        `Everything produced so far is saved. Raise the budget for this request to ` +
        `about ${formatCents(spentCents + wouldSpendCents)} and run it again to continue.`,
    );
    this.name = "BudgetExceededError";
  }
}

export async function assertWithinBudget(
  requestId: string,
  wouldSpendCents: number,
): Promise<void> {
  await assertExecutionActive();
  const db = serviceClient();
  const { data, error } = await db
    .from(table("content_requests"))
    .select("actual_cost_cents, budget_cents, cost_complete, reserved_cost_cents")
    .eq("id", requestId)
    .single();

  if (error || !data) {
    throw new Error(
      `Could not read the budget for request ${requestId}, so the call was not made. ` +
        `(${error?.message ?? "no row"})`,
    );
  }

  const spent = Number(data.actual_cost_cents ?? 0) + Number(data.reserved_cost_cents ?? 0);
  if (spent + wouldSpendCents > data.budget_cents) {
    throw new BudgetExceededError(requestId, spent, wouldSpendCents, data.budget_cents);
  }
}

export async function reserveModelCall(id: string, requestId: string, step: string, model: string, ceiling: number): Promise<void> {
  await assertExecutionActive();
  const { data, error } = await serviceClient().rpc("reserve_model_call", { p_id: id, p_request_id: requestId, p_step: step, p_model: model, p_ceiling: ceiling, p_monthly_limit: env.limits.monthlyCapCents, p_lease_id: executionLeaseId() ?? null });
  if (error || !data) throw new Error("Could not reserve the provider budget: " + (error?.message ?? "no result"));
  if (!data.allowed) {
    if (data.scope === "workspace") throw new Error("The workspace monthly spending limit has been reached. No provider call was made.");
    throw new BudgetExceededError(requestId, Number(data.spent), ceiling, Number(data.budget));
  }
}

export interface RecordCallInput {
  id?: string;
  inputHash?: string;
  response?: unknown;
  usageKnown?: boolean;
  costCeilingCents?: number;
  requestId: string | null;
  step: string;
  purpose?: string;
  model: string;
  usage: TokenUsage;
  outcome: ModelCallOutcome;
  error?: string;
  latencyMs?: number;

  costCentsOverride?: number;
}

export async function recordModelCall(input: RecordCallInput): Promise<number> {
  const db = serviceClient();
  const costCents = input.costCentsOverride ?? priceModelCall(input.model, input.usage);
  const record = {
    id: input.id ?? randomUUID(), request_id: input.requestId, step: input.step,
    purpose: input.purpose ?? null, model: input.model,
    input_tokens: input.usage.inputTokens, output_tokens: input.usage.outputTokens,
    cache_read_tokens: input.usage.cacheReadTokens ?? 0,
    cache_creation_tokens: input.usage.cacheCreationTokens ?? 0,
    web_searches: input.usage.webSearches ?? 0, cost_cents: costCents,
    outcome: input.outcome, error: input.error ?? null, latency_ms: input.latencyMs ?? null,
    input_hash: input.inputHash ?? null, response_json: input.response ?? null,
    cost_ceiling_cents: input.costCeilingCents ?? 0,
  };
  // One transaction records the call, its checkpoint and its cost. The UUID
  // makes retrying a failed accounting write safe, with no duplicate charge.
  let error: { message: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await db.rpc("record_model_call", {
      p_call: record, p_complete: input.usageKnown !== false,
    });
    error = result.error;
    if (!error) return costCents;
  }
  if (input.requestId) {
    await db.from(table("content_requests")).update({ cost_complete: false }).eq("id", input.requestId);
  }
  await logError("Could not save the provider receipt. Work stopped to protect the budget.", {
    requestId: input.requestId, step: input.step, detail: { error: error?.message, callId: record.id },
  });
  throw new Error("Could not save the provider receipt. Check database connectivity before retrying.");
}

export async function checkRateLimit(
  scope: "profile" | "ip" | "global",
  scopeKey: string,
  window: "minute" | "hour" | "day" | "month",
  metric: string,
  limit: number,
): Promise<{ allowed: boolean; current: number; reason?: string }> {
  try {
    const { data, error } = await serviceClient().rpc("read_counter", {
      p_scope: scope,
      p_scope_key: scopeKey,
      p_window: window,
      p_metric: metric,
    });

    if (error) {
      return {
        allowed: false,
        current: -1,
        reason: "The rate-limit counter could not be read, so the request was refused.",
      };
    }

    const current = typeof data === "number" ? data : 0;
    return current >= limit
      ? {
          allowed: false,
          current,
          reason: `Limit of ${limit} per ${window} reached (${current} used).`,
        }
      : { allowed: true, current };
  } catch {
    return {
      allowed: false,
      current: -1,
      reason: "The rate-limit counter could not be read, so the request was refused.",
    };
  }
}

export async function consumeRateLimit(scope: "profile" | "ip" | "global", scopeKey: string,
  window: "minute" | "hour" | "day" | "month", metric: string, limit: number): Promise<{ allowed: boolean; current: number }> {
  try {
    const { data, error } = await serviceClient().rpc("consume_rate_limit", {
      p_scope: scope, p_scope_key: scopeKey, p_window: window, p_metric: metric, p_limit: limit,
    });
    return error || typeof data?.allowed !== "boolean" ? { allowed: false, current: -1 } : data;
  } catch { return { allowed: false, current: -1 }; }
}

export async function bumpCounter(
  scope: "profile" | "ip" | "global",
  scopeKey: string,
  window: "minute" | "hour" | "day" | "month",
  metric: string,
  cents = 0,
): Promise<void> {
  const { error } = await serviceClient().rpc("bump_counter", {
    p_scope: scope,
    p_scope_key: scopeKey,
    p_window: window,
    p_metric: metric,
    p_cents: cents,
  });
  if (error) console.error("[cost] bump_counter failed:", error.message);
}

export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  const dollars = cents / 100;
  if (dollars > 0 && dollars < 0.01) return "<$0.01";
  return `$${dollars.toFixed(2)}`;
}

export function formatCost(cents: number | null | undefined, complete = true): string {
  if (cents == null) return "—";
  return complete ? formatCents(cents) : `at least ${formatCents(cents)}`;
}
