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
 * Embeddings, via OpenAI.
 *
 * DESIGN.md §2.5 is explicit that vectors earn their place here for two
 * reasons, and the second is the real one: they cut what goes into the
 * drafting call (cost), and they let us check whether a sentence actually
 * relates to the excerpt it cites (grounding, §8.4).
 *
 * WAS Voyage. Voyage's free tier allows only a few requests a minute, and the
 * failure mode was not a clean error: six fetched articles of 20k-36k
 * characters were refused, dropped from the corpus, and the symptom surfaced
 * three steps later as "these three angles are too similar". The provider
 * changed; nothing about the grounding contract did.
 *
 * `input_type` is kept in the signature even though OpenAI has no such
 * parameter. Voyage embedded documents and queries into deliberately different
 * regions of the space, so the distinction was load-bearing there; here it is
 * inert, and keeping it means the call sites still read correctly and a move
 * back to an asymmetric model is a one-file change.
 */

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
    const result = await embedBatch(batch);

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

async function embedBatch(texts: string[]): Promise<EmbeddingResponse> {
  // Per §7.4, a source whose chunks could not be embedded is marked and
  // excluded from vector selection but remains available for manual inclusion —
  // it is never silently dropped.
  let lastError: unknown;

  /**
   * Several attempts with a long backoff, because a rate limit is PER MINUTE.
   *
   * Kept after the move off Voyage even though OpenAI's paid limits are far
   * higher and this should now be dead code in practice. It is cheap, and the
   * failure it defends against was expensive: batches refused with 429, six
   * good articles dropped from the corpus, and a symptom that surfaced three
   * steps away as "three angles are too similar".
   *
   * One retry a second later cannot clear a per-minute window. Waiting does.
   */
  for (let attempt = 0; attempt <= EMBED_RETRY_ATTEMPTS; attempt++) {
    try {
      await paceRequest();

      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.embeddings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Voyage truncated oversize input on request; OpenAI returns a 400
          // instead, so the clamp happens here. A chunk long enough to hit this
          // is already far past the chunker's target size (§5.5).
          input: texts.map(clampToTokenLimit),
          model: EMBEDDING_MODEL,
          // Native 1536 dims, shortened to 512. Not a truncation of a larger
          // vector: the model is trained so a shortened vector stays usable,
          // and the pgvector column is declared at 512.
          dimensions: EMBEDDING_DIMENSIONS,
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
        if (!retryable || attempt === EMBED_RETRY_ATTEMPTS) throw error;
        lastError = error;
        await sleep(backoffMs(attempt, response.status));
        continue;
      }

      return (await response.json()) as EmbeddingResponse;
    } catch (err) {
      if (err instanceof EmbeddingError && !err.retryable) throw err;
      if (attempt === EMBED_RETRY_ATTEMPTS) throw err;
      lastError = err;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new EmbeddingError("Voyage embedding failed for an unknown reason.");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenAI rejects an input over 8,192 tokens with a 400 rather than truncating,
 * and a 400 is not retryable — so one oversized chunk would fail its whole
 * batch and take a usable source out of the corpus with it.
 *
 * The chunker targets a few hundred tokens (§5.5), so this should never fire.
 * It exists because "should never fire" is exactly what was assumed about the
 * rate limit. Clamped well below the ceiling, since estimateTokens is an
 * estimate and a boundary this cheap is not worth being precise about.
 */
const MAX_INPUT_CHARS = 24_000;

function clampToTokenLimit(text: string): string {
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

/** Enough attempts to outlast a per-minute rate-limit window. */
const EMBED_RETRY_ATTEMPTS = 4;

/**
 * Minimum gap between embedding requests, process-wide.
 *
 * Backing off after a 429 is recovery; this is prevention. Sized for OpenAI's
 * paid limits (thousands of requests a minute), so this is a courtesy spacer
 * rather than the load-bearing throttle it had to be on Voyage's free tier —
 * where 1.2s a call was the difference between a full corpus and two sources.
 */
const MIN_REQUEST_GAP_MS = 50;

let lastRequestAt = 0;

async function paceRequest(): Promise<void> {
  const since = Date.now() - lastRequestAt;
  if (since < MIN_REQUEST_GAP_MS) {
    await sleep(MIN_REQUEST_GAP_MS - since);
  }
  lastRequestAt = Date.now();
}

/**
 * How long to wait before trying again.
 *
 * A 429 from Voyage is a per-MINUTE quota, so the wait has to be measured in
 * tens of seconds — 15s, 30s, 45s, 60s. Anything shorter just spends another
 * request confirming the window has not reset, which is what threw away six
 * usable articles.
 *
 * Other errors (5xx, a dropped connection) back off in seconds, since those
 * clear quickly or not at all.
 */
function backoffMs(attempt: number, status?: number): number {
  const jitter = Math.random() * 1_000;
  if (status === 429) return 15_000 * (attempt + 1) + jitter;
  return 2_000 * (attempt + 1) + jitter;
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
