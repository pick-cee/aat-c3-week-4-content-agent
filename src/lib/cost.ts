import "server-only";
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

/**
 * Cost accounting and budget enforcement.
 *
 * Two rules from DESIGN.md drive this file:
 *
 *   Rule 10 — every model call is logged, including discarded ones. A rejected
 *   draft spent real money. `article_versions` keeps what survived;
 *   `model_calls` keeps what was spent.
 *
 *   §18.4 — budget is checked BEFORE every call, against that call's worst
 *   case (assembled input tokens + max_tokens at the output rate). Checking
 *   after the fact is not a budget, it is a receipt.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  webSearches?: number;
}

/** Dollars → cents, kept as a float; rounding happens once, at the database. */
export function priceModelCall(model: string, usage: TokenUsage): number {
  const prices = MODEL_PRICES[model as ModelId];
  if (!prices) {
    // An unpriced model is a costing bug, not a free call. Surfacing it as a
    // warning and charging zero would make the total quietly wrong, so this
    // throws and the caller records the call with cost_complete = false.
    throw new UnpricedModelError(model);
  }

  const inputCost = ((usage.inputTokens - (usage.cacheReadTokens ?? 0)) / 1e6) * prices.input;
  const cacheCost = ((usage.cacheReadTokens ?? 0) / 1e6) * prices.cacheRead;
  const outputCost = (usage.outputTokens / 1e6) * prices.output;
  const searchCost = (usage.webSearches ?? 0) * WEB_SEARCH_PRICE_PER_SEARCH;

  return (inputCost + cacheCost + outputCost + searchCost) * 100;
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

/**
 * The worst case for a call that has not happened yet: every input token
 * charged at full rate, and `max_tokens` all returned.
 */
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

// ─── Budget enforcement ─────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly spentCents: number,
    public readonly wouldSpendCents: number,
    public readonly budgetCents: number,
  ) {
    super(
      `This step would cost about ${formatCents(wouldSpendCents)}, and ` +
        `${formatCents(spentCents)} of the ${formatCents(budgetCents)} budget is ` +
        `already spent. The request stopped here with everything produced so far intact.`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Called before every model call. Throws rather than returning a boolean so a
 * forgotten check is a missing call site, not an ignored return value.
 */
export async function assertWithinBudget(
  requestId: string,
  wouldSpendCents: number,
): Promise<void> {
  const db = serviceClient();
  const { data, error } = await db
    .from(table("content_requests"))
    .select("actual_cost_cents, budget_cents, cost_complete")
    .eq("id", requestId)
    .single();

  if (error || !data) {
    // Fail closed. A budget that cannot be read is not a budget of infinity.
    throw new Error(
      `Could not read the budget for request ${requestId}, so the call was not made. ` +
        `(${error?.message ?? "no row"})`,
    );
  }

  const spent = data.actual_cost_cents ?? 0;
  if (spent + wouldSpendCents > data.budget_cents) {
    throw new BudgetExceededError(requestId, spent, wouldSpendCents, data.budget_cents);
  }
}

// ─── Recording ──────────────────────────────────────────────────────────────

export interface RecordCallInput {
  requestId: string | null;
  step: string;
  purpose?: string;
  model: string;
  usage: TokenUsage;
  outcome: ModelCallOutcome;
  error?: string;
  latencyMs?: number;
  /** Pre-computed cost, for non-model spend (embeddings, scrapes). */
  costCentsOverride?: number;
}

/**
 * Records a call and adds its cost to the request total.
 *
 * If this insert fails, the request's `cost_complete` goes false and every
 * display of that total reads "at least $X" rather than a smaller confident
 * number (§5.3). That is the honest response to a missing row: the money was
 * still spent, and pretending otherwise understates it.
 */
export async function recordModelCall(input: RecordCallInput): Promise<number> {
  const db = serviceClient();

  let costCents = input.costCentsOverride ?? 0;
  let priceKnown = true;

  if (input.costCentsOverride === undefined) {
    try {
      costCents = priceModelCall(input.model, input.usage);
    } catch (err) {
      priceKnown = false;
      costCents = 0;
      await logWarn(
        `Spent money on ${input.model} but have no price for it, so the total is understated.`,
        { requestId: input.requestId, step: input.step, detail: { error: String(err) } },
      );
    }
  }

  const { error } = await db.from(table("model_calls")).insert({
    request_id: input.requestId,
    step: input.step,
    purpose: input.purpose ?? null,
    model: input.model,
    input_tokens: input.usage.inputTokens,
    output_tokens: input.usage.outputTokens,
    cache_read_tokens: input.usage.cacheReadTokens ?? 0,
    web_searches: input.usage.webSearches ?? 0,
    cost_cents: costCents,
    outcome: input.outcome,
    error: input.error ?? null,
    latency_ms: input.latencyMs ?? null,
  });

  if (error) {
    await logError(
      "A model call could not be written to the cost log, so this request's total is incomplete.",
      { requestId: input.requestId, step: input.step, detail: { error: error.message } },
    );
  }

  if (input.requestId) {
    // `complete` false is sticky in the database function: once a total might
    // be missing a call, it can never quietly become confident again.
    const { error: costError } = await db.rpc("add_request_cost", {
      p_request_id: input.requestId,
      p_cents: costCents,
      p_complete: !error && priceKnown,
    });
    if (costError) {
      await logError("Could not add this call's cost to the request total.", {
        requestId: input.requestId,
        step: input.step,
        detail: { error: costError.message },
      });
    }
  }

  return costCents;
}

// ─── Monthly cap and rate limits (§18.4) ────────────────────────────────────

/**
 * Fails CLOSED: if the counter cannot be read, the caller is refused. A public
 * demo with a sign-in button is a public spend button.
 */
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

// ─── Display ────────────────────────────────────────────────────────────────

export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  const dollars = cents / 100;
  // Sub-cent amounts are real here — an embedding batch costs a fraction of a
  // cent — and rounding them to "$0.00" makes the pipeline look free.
  if (dollars > 0 && dollars < 0.01) return "<$0.01";
  return `$${dollars.toFixed(2)}`;
}

/**
 * A total missing a call reads "at least $X" (§5.3, §17). A total that could
 * not be read at all reads "—", never "0".
 */
export function formatCost(cents: number | null | undefined, complete = true): string {
  if (cents == null) return "—";
  return complete ? formatCents(cents) : `at least ${formatCents(cents)}`;
}
