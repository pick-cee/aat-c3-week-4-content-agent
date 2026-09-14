import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { assertWithinBudget, estimateWorstCase, recordModelCall } from "@/lib/cost";
import { WEB_SEARCH_TOOL_TYPE, BLOCKED_SEARCH_DOMAINS } from "@/lib/constants";
import type { ModelCallOutcome } from "@/lib/db/types";

/**
 * The single door to the Anthropic API.
 *
 * Everything that DESIGN.md's "API notes that will bite" warns about lives
 * here rather than at each call site:
 *
 *   · Structured outputs and citations are mutually exclusive — the API
 *     returns 400 if both are enabled. `callStructured` uses
 *     output_config.format with strict: true; `callWithSearch` uses citations
 *     and parses JSON from a fenced block with a repair pass. Nothing can
 *     accidentally ask for both, because no one function offers both.
 *
 *   · Budget is checked BEFORE the call against its worst case (§18.4).
 *   · Every call is recorded, including discarded ones (rule 10).
 */

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: env.anthropic.apiKey, maxRetries: 2 });
  return client;
}

export interface CallContext {
  requestId: string | null;
  step: string;
  purpose?: string;
}

export interface CallResult<T> {
  value: T;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; webSearches: number };
  costCents: number;
  raw: string;
}

/** A cacheable block: brand voice, rubric and SEO rules are identical across calls (§18.4). */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

/**
 * The API accepts at most four `cache_control` breakpoints per request, and
 * refuses the whole call with a 400 beyond that. Drafting alone wants five —
 * the role block, the SEO rules, the citation contract, the linking rule and
 * the brand voice.
 *
 * Enforced here rather than at each call site, so adding a cacheable block
 * somewhere cannot break a request that has nothing to do with it.
 */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Marks up to four blocks as cacheable, keeping the LAST ones.
 *
 * A cache breakpoint caches everything before it, so the marker's position is
 * what matters, not which block carries it. Keeping the later breakpoints
 * covers the most prefix text; dropping an early one costs nothing, because a
 * later breakpoint already caches through that point.
 */
function buildSystem(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  const cacheableIndices = blocks
    .map((block, index) => (block.cache ? index : -1))
    .filter((index) => index !== -1);

  const keep = new Set(cacheableIndices.slice(-MAX_CACHE_BREAKPOINTS));

  return blocks.map((block, index) => ({
    type: "text" as const,
    text: block.text,
    ...(block.cache && keep.has(index) ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

/** Exposed for the unit test; the limit is easy to reintroduce by accident. */
export const buildSystemForTest = buildSystem;

function readUsage(message: Anthropic.Message) {
  const usage = message.usage;
  return {
    inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  };
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * A generation that ran out of room before it finished.
 *
 * This was silent until it caused real damage: a 6,000-token article stopped
 * exactly at the cap, the half-finished markdown was stored as a finished
 * draft, and the evaluator two steps later reported "no article body was
 * submitted" — a confusing symptom three steps from its cause.
 *
 * "Unknown is not zero" (§17) applies to a truncated generation as much as to
 * a failed fetch: a cut-off article is not a short article.
 */
export class TruncatedResponseError extends Error {
  constructor(
    public readonly purpose: string,
    public readonly maxTokens: number,
  ) {
    super(
      `The model hit its ${maxTokens.toLocaleString()}-token limit while ${purpose}, so the ` +
        `output is cut off mid-sentence. It was discarded rather than stored as if it were ` +
        `finished. Raise max_tokens for this step, or narrow what it was asked to produce.`,
    );
    this.name = "TruncatedResponseError";
  }
}

function assertNotTruncated(
  message: Anthropic.Message,
  purpose: string,
  maxTokens: number,
): void {
  if (message.stop_reason === "max_tokens") {
    throw new TruncatedResponseError(purpose, maxTokens);
  }
}

// ─── Structured output ──────────────────────────────────────────────────────

export interface StructuredCallInput<T> {
  context: CallContext;
  model: string;
  system: SystemBlock[];
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  /** Runs before the result is accepted; throwing rejects and retries once. */
  validate?: (value: T) => void;
}

/**
 * A strict-schema call. Used for everything except search: angle planning, the
 * article header, evaluation, channel adaptation and alt text.
 *
 * `strict: true` means the API guarantees the shape, so there is no JSON
 * repair path here — if this ever fails to parse, that is a bug worth seeing
 * rather than papering over.
 */
export async function callStructured<T>(input: StructuredCallInput<T>): Promise<CallResult<T>> {
  const { context, model, system, prompt, schema, maxTokens, temperature } = input;

  const estimatedInput = estimateInputTokens(system, prompt);
  if (context.requestId) {
    await assertWithinBudget(
      context.requestId,
      estimateWorstCase(model, estimatedInput, maxTokens),
    );
  }

  const started = Date.now();
  let message: Anthropic.Message;

  try {
    message = await anthropic().messages.create({
      model,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      system: buildSystem(system),
      messages: [{ role: "user", content: prompt }],
      // Strict shape guaranteed by the API. Never combined with citations —
      // the API returns 400 if both are enabled, which is why search lives in
      // a separate function rather than behind a flag on this one.
      output_config: { format: { type: "json_schema", schema } },
    });
  } catch (err) {
    await recordModelCall({
      requestId: context.requestId,
      step: context.step,
      purpose: context.purpose,
      model,
      usage: { inputTokens: estimatedInput, outputTokens: 0 },
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    });
    throw err;
  }

  const usage = readUsage(message);
  const raw = textOf(message);

  const finish = async (outcome: ModelCallOutcome, error?: string) =>
    recordModelCall({
      requestId: context.requestId,
      step: context.step,
      purpose: context.purpose,
      model,
      usage,
      outcome,
      error,
      latencyMs: Date.now() - started,
    });

  // Checked before parsing: truncated JSON fails to parse, and "unterminated
  // string" is a much worse diagnosis than "it ran out of room".
  if (message.stop_reason === "max_tokens") {
    await finish("discarded", `Truncated at ${maxTokens} tokens.`);
    throw new TruncatedResponseError(context.purpose ?? context.step, maxTokens);
  }

  let value: T;
  try {
    value = JSON.parse(raw) as T;
  } catch (err) {
    await finish("failed", `Strict schema output did not parse: ${String(err)}`);
    throw new Error(
      `A strict-schema call returned unparseable JSON, which should not happen. ` +
        `Raw output: ${raw.slice(0, 500)}`,
    );
  }

  if (input.validate) {
    try {
      input.validate(value);
    } catch (err) {
      // The tokens were still spent. Rule 10: discarded calls are logged.
      await finish("discarded", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  const costCents = await finish("used");
  return { value, usage, costCents, raw };
}

// ─── Free-form text (drafting and revision) ─────────────────────────────────

export interface TextCallInput {
  context: CallContext;
  model: string;
  system: SystemBlock[];
  prompt: string;
  maxTokens: number;
  temperature?: number;
  prefill?: string;
}

/**
 * The article body carries citation markers and free-form prose, so it cannot
 * be schema-constrained (§10). The header is extracted afterwards by a
 * separate strict call over the finished body, which is cheap and reliable.
 */
export async function callText(input: TextCallInput): Promise<CallResult<string>> {
  const { context, model, system, prompt, maxTokens, temperature, prefill } = input;

  const estimatedInput = estimateInputTokens(system, prompt);
  if (context.requestId) {
    await assertWithinBudget(
      context.requestId,
      estimateWorstCase(model, estimatedInput, maxTokens),
    );
  }

  const started = Date.now();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  if (prefill) messages.push({ role: "assistant", content: prefill });

  try {
    const message = await anthropic().messages.create({
      model,
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      system: buildSystem(system),
      messages,
    });

    const usage = readUsage(message);
    const raw = (prefill ?? "") + textOf(message);

    // The article path. A draft cut off at the cap used to be stored as a
    // finished article, and the damage only surfaced at evaluation.
    if (message.stop_reason === "max_tokens") {
      await recordModelCall({
        requestId: context.requestId,
        step: context.step,
        purpose: context.purpose,
        model,
        usage,
        outcome: "discarded",
        error: `Truncated at ${maxTokens} tokens.`,
        latencyMs: Date.now() - started,
      });
      throw new TruncatedResponseError(context.purpose ?? context.step, maxTokens);
    }

    const costCents = await recordModelCall({
      requestId: context.requestId,
      step: context.step,
      purpose: context.purpose,
      model,
      usage,
      outcome: "used",
      latencyMs: Date.now() - started,
    });

    return { value: raw, usage, costCents, raw };
  } catch (err) {
    await recordModelCall({
      requestId: context.requestId,
      step: context.step,
      purpose: context.purpose,
      model,
      usage: { inputTokens: estimatedInput, outputTokens: 0 },
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    });
    throw err;
  }
}

/**
 * Records a call whose output was rejected downstream — a draft that failed
 * marker integrity, an angle set that failed the overlap check.
 *
 * Rule 10 exists because of this path: the tokens were spent whether or not
 * the output survived, and a cost report that only counts successes
 * understates what the pipeline actually costs.
 */
export async function recordDiscarded(
  context: CallContext,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; webSearches?: number },
  reason: string,
): Promise<void> {
  await recordModelCall({
    requestId: context.requestId,
    step: context.step,
    purpose: context.purpose,
    model,
    usage,
    outcome: "discarded",
    error: reason,
  });
}

// ─── Web search ─────────────────────────────────────────────────────────────

export interface SearchCallInput {
  context: CallContext;
  model: string;
  system: SystemBlock[];
  prompt: string;
  maxUses: number;
  maxTokens: number;
  blockedDomains?: string[];
}

export interface SearchCallResult<T> extends CallResult<T> {
  /** URLs the search tool actually surfaced, for the audit trail. */
  citedUrls: string[];
  queries: string[];
}

/**
 * The one place in the system where JSON is not schema-guaranteed, and it is
 * deliberate: search results come back with citations attached, and the API
 * rejects citations + structured outputs together. The alternative is losing
 * search (§7.1).
 *
 * So: parse a fenced JSON block, with a repair pass before failing.
 */
export async function callWithSearch<T>(
  input: SearchCallInput,
): Promise<SearchCallResult<T>> {
  const { context, model, system, prompt, maxUses, maxTokens } = input;

  const estimatedInput = estimateInputTokens(system, prompt);
  if (context.requestId) {
    // Every search counts against the budget even when it returns nothing,
    // so the worst case includes all of them.
    await assertWithinBudget(
      context.requestId,
      estimateWorstCase(model, estimatedInput, maxTokens, maxUses),
    );
  }

  const started = Date.now();
  let message: Anthropic.Message;

  try {
    message = await anthropic().messages.create({
      model,
      max_tokens: maxTokens,
      system: buildSystem(system),
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          type: WEB_SEARCH_TOOL_TYPE,
          name: "web_search",
          max_uses: maxUses,
          blocked_domains: input.blockedDomains ?? BLOCKED_SEARCH_DOMAINS,
          /**
           * Required on Haiku 4.5.
           *
           * The tool defaults to permitting programmatic callers, which Haiku
           * does not support — the call is refused with "does not support
           * programmatic tool calling". Declaring `direct` says the model
           * invokes the tool itself, which is all this pipeline does, and is
           * what keeps discovery on the cheap model §18.2 assigns to it
           * instead of paying Sonnet rates to run a search.
           */
          allowed_callers: ["direct"],
        },
      ],
    });
  } catch (err) {
    await recordModelCall({
      requestId: context.requestId,
      step: context.step,
      purpose: context.purpose,
      model,
      usage: { inputTokens: estimatedInput, outputTokens: 0 },
      outcome: "failed",
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    });
    throw err;
  }

  const usage = readUsage(message);
  const raw = textOf(message);
  const { citedUrls, queries } = extractSearchMetadata(message);

  let value: T;
  try {
    value = parseFencedJson<T>(raw);
  } catch (err) {
    await recordModelCall({
      requestId: context.requestId,
      step: context.step,
      purpose: context.purpose,
      model,
      usage,
      outcome: "discarded",
      error: `Could not parse JSON from the search response: ${String(err)}`,
      latencyMs: Date.now() - started,
    });
    throw err;
  }

  const costCents = await recordModelCall({
    requestId: context.requestId,
    step: context.step,
    purpose: context.purpose,
    model,
    usage,
    outcome: "used",
    latencyMs: Date.now() - started,
  });

  return { value, usage, costCents, raw, citedUrls, queries };
}

/** The URLs the tool actually returned and the queries it ran. */
function extractSearchMetadata(message: Anthropic.Message) {
  const citedUrls = new Set<string>();
  const queries: string[] = [];

  for (const block of message.content as unknown as Record<string, unknown>[]) {
    if (block.type === "server_tool_use" && block.name === "web_search") {
      const query = (block.input as { query?: string } | undefined)?.query;
      if (query) queries.push(query);
    }
    if (block.type === "web_search_tool_result") {
      const content = block.content;
      if (Array.isArray(content)) {
        for (const result of content as { url?: string }[]) {
          if (result.url) citedUrls.add(result.url);
        }
      }
    }
    // Citations attached to text blocks also carry URLs.
    const citations = (block as { citations?: { url?: string }[] }).citations;
    if (Array.isArray(citations)) {
      for (const citation of citations) if (citation.url) citedUrls.add(citation.url);
    }
  }

  return { citedUrls: [...citedUrls], queries };
}

/**
 * Pull JSON out of prose, with a repair pass. §7.1 requires the repair attempt
 * before failing, because losing a paid search call to a trailing comma is a
 * bad trade.
 */
export function parseFencedJson<T>(raw: string): T {
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(raw)) !== null) candidates.push(match[1]!.trim());

  // Unfenced: the outermost array or object in the text.
  const firstArray = raw.indexOf("[");
  const lastArray = raw.lastIndexOf("]");
  if (firstArray !== -1 && lastArray > firstArray) {
    candidates.push(raw.slice(firstArray, lastArray + 1));
  }
  const firstObject = raw.indexOf("{");
  const lastObject = raw.lastIndexOf("}");
  if (firstObject !== -1 && lastObject > firstObject) {
    candidates.push(raw.slice(firstObject, lastObject + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      try {
        return JSON.parse(repairJson(candidate)) as T;
      } catch {
        // Try the next candidate.
      }
    }
  }

  throw new Error(
    `No parseable JSON found in the response. First 400 characters: ${raw.slice(0, 400)}`,
  );
}

/** The repair pass: the malformations a model actually produces. */
function repairJson(input: string): string {
  return input
    .replace(/,(\s*[}\]])/g, "$1")          // trailing comma
    .replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3') // single-quoted keys
    .replace(/:\s*'([^']*)'/g, ': "$1"')    // single-quoted values
    .replace(/\/\/[^\n\r]*/g, "")           // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")       // block comments
    .trim();
}

// ─── Estimation ─────────────────────────────────────────────────────────────

/**
 * Pre-call token estimate for the budget check. Deliberately conservative:
 * over-estimating stops a request slightly early, under-estimating lets it
 * cross the budget, and only one of those is a bug worth having.
 */
function estimateInputTokens(system: SystemBlock[], prompt: string): number {
  const chars = system.reduce((sum, block) => sum + block.text.length, 0) + prompt.length;
  return Math.ceil((chars / 4) * 1.1);
}
