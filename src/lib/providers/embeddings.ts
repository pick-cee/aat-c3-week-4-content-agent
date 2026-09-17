import "server-only";
import { randomUUID } from "node:crypto";
import { env, MissingEnvError } from "@/lib/env";
import { priceEmbedding, reserveModelCall, recordModelCall, assertWithinBudget } from "@/lib/cost";
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_BATCH_SIZE,
} from "@/lib/constants";
import { estimateTokens } from "@/lib/text";



const API_URL = "https://api.openai.com/v1/embeddings";

export type InputType = "document" | "query";

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number; prompt_tokens?: number };
}

export interface EmbedResult {
  embeddings: number[][];
  totalTokens: number;
  costCents: number;
}


export async function embed(texts: string[], inputType: InputType,
  options: { requestId?: string | null; step?: string } = {}): Promise<EmbedResult> {
  const embeddings: number[][] = [];
  let totalTokens = 0, costCents = 0;
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const ceiling = priceEmbedding(estimateEmbeddingTokens(batch) * 1.5);
    if (options.requestId) await assertWithinBudget(options.requestId, ceiling);
    const callId = randomUUID();
    void env.embeddings.apiKey;
    if (options.requestId) await reserveModelCall(callId, options.requestId, options.step ?? "embed", EMBEDDING_MODEL, ceiling);
    const started = Date.now();
    let result: EmbeddingResponse;
    try { result = await embedBatch(batch); }
    catch (error) {
      if (error instanceof MissingEnvError) throw error;
      const known = error instanceof EmbeddingError && !!error.status && error.status >= 400 && error.status < 500 && error.status !== 408;
      await recordModelCall({ id: callId, requestId: options.requestId ?? null, step: options.step ?? "embed",
        purpose: inputType + " embeddings", model: EMBEDDING_MODEL,
        usage: { inputTokens: 0, outputTokens: 0 }, costCentsOverride: 0,
        costCeilingCents: known ? 0 : ceiling, usageKnown: known, outcome: "failed",
        error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started });
      throw error;
    }
    const tokens = result.usage?.total_tokens;
    const known = Number.isFinite(tokens);
    const cost = priceEmbedding(known ? tokens : 0);
    await recordModelCall({ id: callId, requestId: options.requestId ?? null, step: options.step ?? "embed",
      purpose: inputType + " embeddings", model: EMBEDDING_MODEL,
      usage: { inputTokens: known ? tokens : 0, outputTokens: 0 }, costCentsOverride: cost,
      usageKnown: known, costCeilingCents: known ? 0 : ceiling, outcome: "used", latencyMs: Date.now() - started });
    const sorted = [...result.data].sort((a,b) => a.index - b.index);
    if (sorted.length !== batch.length || sorted.some((item,index) => item.index !== index ||
      item.embedding.length !== EMBEDDING_DIMENSIONS || item.embedding.some(v => !Number.isFinite(v)))) {
      throw new EmbeddingError("OpenAI returned an incomplete or invalid embedding batch.");
    }
    embeddings.push(...sorted.map(item => item.embedding));
    totalTokens += known ? tokens : 0;
    costCents += cost;
  }
  return { embeddings, totalTokens, costCents };
}

export async function embedOne(
  text: string,
  inputType: InputType,
  options: { requestId?: string | null; step?: string } = {},
): Promise<number[]> {
  const { embeddings } = await embed([text], inputType, options);
  const first = embeddings[0];
  if (!first) throw new EmbeddingError("OpenAI returned no embedding for a single input.");
  return first;
}

async function embedBatch(texts: string[]): Promise<EmbeddingResponse> {
  try {
    const response = await fetch(API_URL, {
      method: "POST", headers: { Authorization: "Bearer " + env.embeddings.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ input: texts.map(t => t.slice(0,24_000)), model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new EmbeddingError("OpenAI embeddings returned " + response.status + ": " + (await response.text()).slice(0,300),
        response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    }
    return await response.json() as EmbeddingResponse;
  } catch (error) {
    if (error instanceof EmbeddingError || error instanceof MissingEnvError) throw error;
    throw new EmbeddingError(error instanceof Error ? error.message : "Embedding connection failed", undefined, true);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare vectors of length ${a.length} and ${b.length}.`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}


export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}


export function parseVector(value: string | number[] | null): number[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value) as number[];
  } catch {
    return null;
  }
}

export function estimateEmbeddingTokens(texts: string[]): number {
  return texts.reduce((sum, text) => sum + estimateTokens(text), 0);
}
