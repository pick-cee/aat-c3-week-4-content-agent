import "server-only";
import { env } from "@/lib/env";
import { priceEmbedding, recordModelCall } from "@/lib/cost";
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_BATCH_SIZE,
} from "@/lib/constants";
import { estimateTokens } from "@/lib/text";

/**
 * Voyage embeddings.
 *
 * DESIGN.md §2.5 is explicit that vectors earn their place here for two
 * reasons, and the second is the real one: they cut what goes into the
 * drafting call (cost), and they let us check whether a sentence actually
 * relates to the excerpt it cites (grounding, §8.4).
 *
 * `input_type` matters and is not cosmetic — documents and queries are
 * embedded into deliberately different regions of the space, so a document
 * embedded as a query scores badly against its own text.
 */

const API_URL = "https://api.voyageai.com/v1/embeddings";

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

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

export interface EmbedResult {
  embeddings: number[][];
  totalTokens: number;
  costCents: number;
}

/**
 * Embeds texts in batches of 128. Order is preserved: callers zip the result
 * back onto their rows by index, so a reordered response would corrupt every
 * excerpt's embedding silently.
 */
export async function embed(
  texts: string[],
  inputType: InputType,
  options: { requestId?: string | null; step?: string } = {},
): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], totalTokens: 0, costCents: 0 };

  const embeddings: number[][] = [];
  let totalTokens = 0;

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const result = await embedBatch(batch, inputType);

    // The API returns an `index` per item; sorting by it rather than trusting
    // array order is cheap insurance on the one thing that would fail silently.
    const sorted = [...result.data].sort((a, b) => a.index - b.index);
    if (sorted.length !== batch.length) {
      throw new EmbeddingError(
        `Voyage returned ${sorted.length} embeddings for ${batch.length} inputs.`,
      );
    }
    for (const item of sorted) embeddings.push(item.embedding);
    totalTokens += result.usage?.total_tokens ?? 0;
  }

  const costCents = priceEmbedding(totalTokens);

  if (options.requestId) {
    await recordModelCall({
      requestId: options.requestId,
      step: options.step ?? "embed",
      purpose: `${inputType} embeddings`,
      model: EMBEDDING_MODEL,
      usage: { inputTokens: totalTokens, outputTokens: 0 },
      outcome: "used",
      costCentsOverride: costCents,
    });
  }

  return { embeddings, totalTokens, costCents };
}

/** Convenience for the single-text case: the request vector, a sentence. */
export async function embedOne(
  text: string,
  inputType: InputType,
  options: { requestId?: string | null; step?: string } = {},
): Promise<number[]> {
  const { embeddings } = await embed([text], inputType, options);
  const first = embeddings[0];
  if (!first) throw new EmbeddingError("Voyage returned no embedding for a single input.");
  return first;
}

async function embedBatch(texts: string[], inputType: InputType): Promise<VoyageResponse> {
  // One retry, per §7.4. A source whose chunks could not be embedded is marked
  // and excluded from vector selection but remains available for manual
  // inclusion — it is never silently dropped.
  let lastError: unknown;

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.voyage.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: texts,
          model: EMBEDDING_MODEL,
          input_type: inputType,
          output_dimension: EMBEDDING_DIMENSIONS,
          truncation: true,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const retryable = response.status === 429 || response.status >= 500;
        const error = new EmbeddingError(
          `Voyage returned ${response.status}: ${body.slice(0, 300)}`,
          response.status,
          retryable,
        );
        if (!retryable || attempt === 1) throw error;
        lastError = error;
        await sleep(1_000 * (attempt + 1) + Math.random() * 500);
        continue;
      }

      return (await response.json()) as VoyageResponse;
    } catch (err) {
      if (err instanceof EmbeddingError && !err.retryable) throw err;
      if (attempt === 1) throw err;
      lastError = err;
      await sleep(1_000 + Math.random() * 500);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new EmbeddingError("Voyage embedding failed for an unknown reason.");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Similarity ─────────────────────────────────────────────────────────────

/**
 * Cosine similarity. Voyage returns normalised vectors, so a dot product would
 * do — but normalising explicitly costs nothing and means a change of provider
 * cannot silently break every grounding threshold in the system.
 */
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

/** pgvector's literal format for an embedding column. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** The reverse: pgvector returns the column as a string through PostgREST. */
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
