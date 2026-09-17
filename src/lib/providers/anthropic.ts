import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { serviceClient, table } from "@/lib/db/client";
import { assertWithinBudget, estimateWorstCase, priceModelCall, reserveModelCall, recordModelCall, type TokenUsage } from "@/lib/cost";
import { WEB_SEARCH_TOOL_TYPE, BLOCKED_SEARCH_DOMAINS, PROVIDER_TIMEOUT_MS } from "@/lib/constants";
import { PermanentPipelineError } from "@/lib/pipeline/errors";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // The runner owns transient retries. SDK retries multiplied them invisibly.
  return client ??= new Anthropic({ apiKey: env.anthropic.apiKey, maxRetries: 0, timeout: PROVIDER_TIMEOUT_MS });
}
export interface CallContext { requestId: string | null; step: string; purpose?: string }
export interface CallResult<T> {
  value: T;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; webSearches: number };
  costCents: number;
  raw: string;
  callId: string;
}
export interface SystemBlock { text: string; cache?: boolean }
function buildSystem(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  const keep = new Set(blocks.map((b,i) => b.cache ? i : -1).filter(i => i >= 0).slice(-4));
  return blocks.map((b,i) => ({ type: "text", text: b.text,
    ...(keep.has(i) ? { cache_control: { type: "ephemeral" as const } } : {}) }));
}
export const buildSystemForTest = buildSystem;
export function readUsage(message: Anthropic.Message) {
  const u = message.usage;
  return { inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0 };
}
function textOf(message: Anthropic.Message): string {
  return message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("\n");
}
export class TruncatedResponseError extends PermanentPipelineError {
  constructor(public readonly purpose: string, public readonly maxTokens: number) {
    super("The model stopped before finishing " + purpose + ". Shorten the brief or request a smaller article.");
    this.name = "TruncatedResponseError";
  }
}
export function widenedLimit(maxTokens: number): number { return Math.min(maxTokens * 2, 16_000); }
export interface TextCallInput {
  context: CallContext; model: string; system: SystemBlock[]; prompt: string;
  maxTokens: number; temperature?: number; prefill?: string;
}
export interface StructuredCallInput<T> extends TextCallInput {
  schema: Record<string, unknown>; validate?: (value: T) => void;
}
export interface SearchCallInput extends TextCallInput { maxUses: number; blockedDomains?: string[] }
export interface SearchCallResult<T> extends CallResult<T> { citedUrls: string[]; queries: string[] }

// Only completed, accepted responses are reused, scoped to this request and the
// exact model, prompt, schema and output limit. A restart after generation no
// longer buys the same response again just because saving the article failed.
async function generate<T>(
  input: TextCallInput,
  extra: Pick<Anthropic.MessageCreateParamsNonStreaming, "tools" | "output_config">,
  decode: (message: Anthropic.Message, raw: string) => T,
): Promise<CallResult<T>> {
  const { context, model, system, prompt, maxTokens } = input;
  const hash = createHash("sha256").update(JSON.stringify({ model, system, prompt, maxTokens,
    temperature: input.temperature, prefill: input.prefill, extra, contract: 2 })).digest("hex");
  if (context.requestId) {
    const { data, error } = await serviceClient().from(table("model_calls"))
      .select("id, response_json").eq("request_id", context.requestId).eq("input_hash", hash)
      .eq("outcome", "used").not("response_json", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error("Could not read generation checkpoints: " + error.message);
    if (data?.response_json) return data.response_json as unknown as CallResult<T>;
  }
  const estimatedInput = estimateInputTokens(system, prompt);
  const searches = (extra.tools?.[0] as { max_uses?: number } | undefined)?.max_uses ?? 0;
  // Search result tokens and cache creation also cost money.
  const ceiling = estimateWorstCase(model, Math.ceil(estimatedInput * 1.25) + searches * 8_000, maxTokens, searches);
  if (context.requestId) await assertWithinBudget(context.requestId, ceiling);
  const callId = randomUUID();
  const api = anthropic();
  if (context.requestId) await reserveModelCall(callId, context.requestId, context.step, model, ceiling);
  const started = Date.now();
  let message: Anthropic.Message;
  try {
    message = await api.messages.create({
      model, max_tokens: maxTokens, thinking: { type: "disabled" },
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      system: buildSystem(system), messages: [{ role: "user", content: prompt },
        ...(input.prefill ? [{ role: "assistant" as const, content: input.prefill }] : [])],
      ...extra,
    });
  } catch (error) {
    // An HTTP refusal has known zero usage; a lost response does not. Reserve
    // its ceiling against the budget instead of guessing tokens or calling it free.
    const status = (error as { status?: number }).status;
    const known = typeof status === "number" && status >= 400 && status < 500 && status !== 408;
    await recordModelCall({ id: callId, requestId: context.requestId, step: context.step,
      purpose: context.purpose, model, usage: { inputTokens: 0, outputTokens: 0 },
      outcome: "failed", usageKnown: known, costCeilingCents: known ? 0 : ceiling,
      error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started });
    throw error;
  }
  const raw = (input.prefill ?? "") + textOf(message);
  const usage = readUsage(message);
  let value: T;
  try {
    if (message.stop_reason === "max_tokens") throw new TruncatedResponseError(context.purpose ?? context.step, maxTokens);
    if (message.stop_reason !== "end_turn" && message.stop_reason !== "stop_sequence") {
      throw new PermanentPipelineError("The provider did not finish this response (" + message.stop_reason + ").");
    }
    value = decode(message, raw);
  } catch (error) {
    await recordModelCall({ id: callId, requestId: context.requestId, step: context.step,
      purpose: context.purpose, model, usage, outcome: "discarded",
      error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started });
    throw error;
  }
  const result: CallResult<T> = { value, usage, raw, callId, costCents: priceModelCall(model, usage) };
  result.costCents = await recordModelCall({ id: callId, requestId: context.requestId,
    step: context.step, purpose: context.purpose, model, usage, outcome: "used",
    latencyMs: Date.now() - started, inputHash: hash, response: result });
  return result;
}

export function callStructured<T>(input: StructuredCallInput<T>): Promise<CallResult<T>> {
  return generate(input, { output_config: { format: { type: "json_schema", schema: input.schema } } }, (_m,raw) => {
    const value = JSON.parse(raw) as T;
    input.validate?.(value);
    return value;
  });
}
export function callText(input: TextCallInput): Promise<CallResult<string>> {
  return generate(input, {}, (_m,raw) => raw);
}
export async function recordDiscarded(
  context: CallContext, _model: string, _usage: TokenUsage, reason: string, callId: string,
): Promise<void> {
  const { error } = await serviceClient().from(table("model_calls"))
    .update({ outcome: "discarded", error: reason, response_json: null })
    .eq("id", callId).eq("request_id", context.requestId!);
  if (error) throw new Error("Could not record the rejected response: " + error.message);
}
export async function callWithSearch<T>(input: SearchCallInput): Promise<SearchCallResult<T>> {
  const result = await generate(input, { tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search",
    max_uses: input.maxUses, blocked_domains: input.blockedDomains ?? BLOCKED_SEARCH_DOMAINS,
    allowed_callers: ["direct"] }] }, (m,raw) => ({ parsed: parseFencedJson<T>(raw), ...extractSearchMetadata(m) }));
  return { ...result, value: result.value.parsed, citedUrls: result.value.citedUrls, queries: result.value.queries };
}

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
    const citations = (block as { citations?: { url?: string }[] }).citations;
    if (Array.isArray(citations)) {
      for (const citation of citations) if (citation.url) citedUrls.add(citation.url);
    }
  }

  return { citedUrls: [...citedUrls], queries };
}

export function parseFencedJson<T>(raw: string): T {
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(raw)) !== null) candidates.push(match[1]!.trim());
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
      }
    }
  }

  throw new Error(
    `No parseable JSON found in the response. First 400 characters: ${raw.slice(0, 400)}`,
  );
}

function repairJson(input: string): string {
  // Protect strings before repairing syntax. Regex-only repair silently
  // truncated https:// URLs and changed punctuation inside quoted evidence.
  const strings: string[] = [];
  const protectedInput = input.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g, token => {
    if (token.startsWith("/")) return "";
    const quoted = token.startsWith("'")
      ? JSON.stringify(token.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\"))
      : token;
    return `\u0000${strings.push(quoted) - 1}\u0000`;
  });
  return protectedInput.replace(/,(\s*[}\]])/g, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => strings[Number(index)]!).trim();
}

function estimateInputTokens(system: SystemBlock[], prompt: string): number {
  const chars = system.reduce((sum, block) => sum + block.text.length, 0) + prompt.length;
  return Math.ceil((chars / 4) * 1.1);
}
