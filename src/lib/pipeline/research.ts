import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn, logError } from "@/lib/log";
import { scrape, isUsableSource } from "@/lib/providers/firecrawl";
import { callWithSearch } from "@/lib/providers/anthropic";
import { embed, toVectorLiteral } from "@/lib/providers/voyage";
import { chunkMarkdown } from "./chunking";
import { priceScrapes, recordModelCall } from "@/lib/cost";
import {
  canonicaliseUrl,
  isValidUrl,
  siteNameFromUrl,
  estimateTokens,
} from "@/lib/text";
import {
  MAX_TOKENS,
  MODELS,
  WEB_SEARCH_MAX_USES,
  WEB_SEARCH_MAX_USES_TOPUP,
  FETCH_BATCH_SIZE,
  FETCH_CONCURRENCY,
  MIN_SOURCES_FOR_RESEARCH,
  EMBEDDING_BATCH_SIZE,
} from "@/lib/constants";
import type { ContentRequest, Source } from "@/lib/db/types";

/**
 * Research: discovery → fetch → chunk_embed → score. DESIGN.md §7.
 *
 * Each is a separate runner step, resumable from what is already in the table
 * (§3.1), because the whole sequence — a search call, six scrapes with
 * retries, chunking and an embedding batch — does not reliably finish inside a
 * serverless function's execution budget.
 */

// ─── Step: discover (§7.1, §7.2) ────────────────────────────────────────────

interface DiscoveredSource {
  url: string;
  title?: string;
  why?: string;
  confidence?: number;
}

export interface DiscoverResult {
  seeded: number;
  discovered: number;
  queries: string[];
  /** 'no_sources_found' stops the request at needs_human, not at an article. */
  outcome: "ok" | "no_sources_found";
}

export async function stepDiscover(request: ContentRequest): Promise<DiscoverResult> {
  const db = serviceClient();
  const seedUrls = request.seed_urls ?? [];

  // Seed URLs are inserted first and always, search or no search.
  let seeded = 0;
  for (const url of seedUrls) {
    if (!isValidUrl(url)) continue;
    const inserted = await insertSource(request.id, url, "seed", null);
    if (inserted) seeded++;
  }

  // §7.2: seed URLs skip search entirely. This is a deliberate $10/1000 saved
  // on every URL-based request, and it is the answer to "when should this
  // automation NOT run".
  const needsSearch = seedUrls.length === 0 || wantsTopUp(request);

  if (!needsSearch) {
    await logInfo(
      `Using the ${seeded} source${seeded === 1 ? "" : "s"} you supplied. No search was run, which saves the search cost.`,
      { requestId: request.id, step: "discover" },
    );
    return { seeded, discovered: 0, queries: [], outcome: seeded > 0 ? "ok" : "no_sources_found" };
  }

  const maxUses = seedUrls.length > 0 ? WEB_SEARCH_MAX_USES_TOPUP : WEB_SEARCH_MAX_USES;

  let discovered = 0;
  let queries: string[] = [];

  try {
    const result = await callWithSearch<DiscoveredSource[]>({
      context: { requestId: request.id, step: "discover", purpose: "find reference material" },
      model: MODELS.discovery,
      maxUses,
      maxTokens: MAX_TOKENS.discovery,
      system: [
        {
          text:
            "You find reference material for a content team. You search the web and report " +
            "which results are worth reading, and why.\n\n" +
            "Prefer primary sources, original research, official documentation and named " +
            "publications. Avoid listicles, SEO farms and pages that only summarise other " +
            "pages.\n\n" +
            "Reply with ONLY a fenced JSON block, no prose before or after:\n" +
            "```json\n" +
            '[{"url": "...", "title": "...", "why": "one line on what this contributes", ' +
            '"confidence": 0.0}]\n' +
            "```\n" +
            "Between 3 and 8 results. `confidence` is 0 to 1. Every url must be one you " +
            "actually saw in a search result — do not construct or guess a URL.",
        },
      ],
      prompt: buildDiscoveryPrompt(request, seedUrls),
    });

    queries = result.queries;

    for (const item of result.value ?? []) {
      if (!item?.url || !isValidUrl(item.url)) continue;
      const inserted = await insertSource(
        request.id,
        item.url,
        "discovered",
        queries.join(" | ") || null,
        item.title,
      );
      if (inserted) discovered++;
    }

    await db
      .from(table("content_requests"))
      .update({ research_queries: { queries, resultCount: discovered } })
      .eq("id", request.id);
  } catch (err) {
    // A failed search when the manager supplied URLs is survivable: proceed on
    // what they gave us rather than failing the request (§7.3, partial success).
    if (seeded > 0) {
      await logWarn(
        "The web search failed, so research is continuing with only the URLs you supplied.",
        { requestId: request.id, step: "discover", detail: { error: String(err) } },
      );
    } else {
      throw err;
    }
  }

  const total = seeded + discovered;

  if (total === 0) {
    // §7.1: zero results is NOT a failure and NOT an empty article. Week 2's
    // lesson — a zero that looks like a number is worse than an error.
    await db
      .from(table("content_requests"))
      .update({ research_outcome: "no_sources_found", research_queries: { queries } })
      .eq("id", request.id);

    await logWarn(
      "The search returned nothing usable for this topic, so no article was written.",
      { requestId: request.id, step: "discover", detail: { queries } },
    );
    return { seeded, discovered, queries, outcome: "no_sources_found" };
  }

  await logInfo(
    `Found ${total} source${total === 1 ? "" : "s"} to read` +
      (seeded > 0 && discovered > 0
        ? ` (${seeded} you supplied, ${discovered} found by search).`
        : "."),
    { requestId: request.id, step: "discover", detail: { queries } },
  );

  return { seeded, discovered, queries, outcome: "ok" };
}

/**
 * A request with seed URLs AND a broad idea runs one search with max_uses: 2
 * to top up (§7.2). "Broad" is judged on the idea asking for more than the
 * supplied pages can answer.
 */
function wantsTopUp(request: ContentRequest): boolean {
  return /\b(research|find|latest|trends?|compare|landscape|state of|examples?|statistics|data)\b/i.test(
    request.idea,
  );
}

function buildDiscoveryPrompt(request: ContentRequest, seedUrls: string[]): string {
  const parts = [
    `Content idea: ${request.idea}`,
    `Target audience: ${request.target_audience}`,
  ];
  if (request.primary_keyword) parts.push(`Primary keyword: ${request.primary_keyword}`);
  if (seedUrls.length > 0) {
    parts.push(
      `\nThe team already has these sources, so do NOT return them or near-duplicates:\n${seedUrls
        .map((u) => `- ${u}`)
        .join("\n")}\n\nFind material that ADDS to these.`,
    );
  }
  parts.push("\nSearch for reference material and report what is worth reading.");
  return parts.join("\n");
}

/**
 * Insert is idempotent on (request_id, url_canonical), so the same article at
 * two URLs with tracking params becomes one source (§5.4, §21.1). Returns
 * false when the row already existed.
 */
async function insertSource(
  requestId: string,
  url: string,
  origin: "seed" | "discovered",
  viaQuery: string | null,
  title?: string,
): Promise<boolean> {
  let canonical: string;
  try {
    canonical = canonicaliseUrl(url);
  } catch {
    return false;
  }

  const { error } = await serviceClient().from(table("sources")).insert({
    request_id: requestId,
    url,
    url_canonical: canonical,
    origin,
    discovered_via_query: viaQuery,
    title: title ?? null,
    site_name: siteNameFromUrl(url),
    fetch_status: "pending",
  });

  // A duplicate is the constraint doing its job, not an error.
  if (error) return !error.message.includes("duplicate");
  return true;
}

// ─── Step: fetch (§7.3) ─────────────────────────────────────────────────────

export interface FetchStepResult {
  attempted: number;
  succeeded: number;
  failed: number;
  remaining: number;
  /** True when every pending URL has now been attempted. */
  complete: boolean;
}

/**
 * Fetches up to FETCH_BATCH_SIZE pending URLs, then returns. Sized to fit the
 * function budget; the runner calls it again while `complete` is false (§3.1).
 */
export async function stepFetch(request: ContentRequest): Promise<FetchStepResult> {
  const db = serviceClient();

  const { data: pending } = await db
    .from(table("sources"))
    .select("id, url, url_canonical")
    .eq("request_id", request.id)
    .eq("fetch_status", "pending")
    .limit(FETCH_BATCH_SIZE);

  if (!pending || pending.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, remaining: 0, complete: true };
  }

  let succeeded = 0;
  let failed = 0;
  let credits = 0;

  // Concurrency capped at 4 (§7.3).
  for (let i = 0; i < pending.length; i += FETCH_CONCURRENCY) {
    const batch = pending.slice(i, i + FETCH_CONCURRENCY);

    await Promise.all(
      batch.map(async (source) => {
        const result = await scrape(source.url as string);
        credits += result.creditsUsed;

        await db
          .from(table("sources"))
          .update({
            fetch_status: result.status,
            fetch_error: result.error,
            http_status: result.httpStatus,
            title: result.title,
            site_name: result.siteName ?? siteNameFromUrl(source.url as string),
            author: result.author,
            published_at: result.publishedAt,
            markdown: result.markdown,
            markdown_chars: result.markdownChars,
            content_hash: result.contentHash,
            from_cache: result.fromCache,
            credits_used: result.creditsUsed,
            fetched_at: new Date().toISOString(),
            // A source that could not be read is unchecked by default but
            // still visible at gate one and on the public source list (§5.4).
            included: isUsableSource(result.status),
          })
          .eq("id", source.id as string);

        if (isUsableSource(result.status)) succeeded++;
        else failed++;
      }),
    );
  }

  if (credits > 0) {
    await recordModelCall({
      requestId: request.id,
      step: "fetch",
      purpose: `${credits} Firecrawl scrape credit(s)`,
      model: "firecrawl",
      usage: { inputTokens: 0, outputTokens: 0 },
      outcome: "used",
      costCentsOverride: priceScrapes(credits),
    });
  }

  const { count: remaining } = await db
    .from(table("sources"))
    .select("id", { count: "exact", head: true })
    .eq("request_id", request.id)
    .eq("fetch_status", "pending");

  return {
    attempted: pending.length,
    succeeded,
    failed,
    remaining: remaining ?? 0,
    complete: (remaining ?? 0) === 0,
  };
}

/**
 * Decides whether research produced enough to proceed (§7.3).
 *
 * "Partial research is a valid outcome and must look like one." Four of six
 * fetching is fine. Zero stops. Fewer than two with no seed URLs stops —
 * one source is not research.
 */
export async function assessResearch(request: ContentRequest): Promise<{
  ok: boolean;
  usable: number;
  failed: number;
  reason?: string;
}> {
  const { data: sources } = await serviceClient()
    .from(table("sources"))
    .select("fetch_status")
    .eq("request_id", request.id);

  const rows = (sources ?? []) as Pick<Source, "fetch_status">[];
  const usable = rows.filter((s) => isUsableSource(s.fetch_status)).length;
  const failed = rows.length - usable;

  if (usable === 0) {
    return {
      ok: false,
      usable,
      failed,
      reason:
        rows.length === 0
          ? "No sources were found for this topic."
          : `All ${rows.length} sources failed to fetch, so there is nothing to write from.`,
    };
  }

  const hadSeeds = (request.seed_urls ?? []).length > 0;
  if (usable < MIN_SOURCES_FOR_RESEARCH && !hadSeeds) {
    return {
      ok: false,
      usable,
      failed,
      reason: `Only ${usable} source could be read. One source is not research, so this stopped rather than writing from it.`,
    };
  }

  return { ok: true, usable, failed };
}

// ─── Step: chunk_embed (§7.4) ───────────────────────────────────────────────

export interface ChunkEmbedResult {
  sourcesProcessed: number;
  excerptsCreated: number;
  embedFailures: number;
  complete: boolean;
}

/**
 * Chunks and embeds one source per invocation, so a long page cannot blow the
 * function budget. Resumable: a source that already has excerpts is skipped.
 */
export async function stepChunkEmbed(request: ContentRequest): Promise<ChunkEmbedResult> {
  const db = serviceClient();

  const { data: sources } = await db
    .from(table("sources"))
    .select("id, markdown, fetch_status, embed_failed, title")
    .eq("request_id", request.id)
    .in("fetch_status", ["ok", "too_large", "redirected_offsite"]);

  const candidates = (sources ?? []) as Pick<
    Source,
    "id" | "markdown" | "fetch_status" | "embed_failed" | "title"
  >[];

  const { data: existing } = await db
    .from(table("excerpts"))
    .select("source_id")
    .eq("request_id", request.id);

  const done = new Set((existing ?? []).map((r) => r.source_id as string));
  const pending = candidates.filter((s) => !done.has(s.id) && !s.embed_failed);

  if (pending.length === 0) {
    return { sourcesProcessed: 0, excerptsCreated: 0, embedFailures: 0, complete: true };
  }

  const source = pending[0]!;
  let created = 0;
  let embedFailures = 0;

  const chunks = chunkMarkdown(source.markdown ?? "");

  if (chunks.length === 0) {
    await db
      .from(table("sources"))
      .update({ embed_failed: true, embed_error: "The page produced no chunks to embed." })
      .eq("id", source.id);
    embedFailures++;
  } else {
    try {
      // Embedded as DOCUMENTS. The input type is not interchangeable with the
      // query type used for sentences and the request vector.
      const { embeddings } = await embed(
        chunks.map((c) => c.text),
        "document",
        { requestId: request.id, step: "chunk_embed" },
      );

      const rows = chunks.map((chunk, i) => ({
        source_id: source.id,
        request_id: request.id,
        ordinal: chunk.ordinal,
        text: chunk.text,
        heading_path: chunk.headingPath || null,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
        token_estimate: chunk.tokenEstimate,
        embedding: embeddings[i] ? toVectorLiteral(embeddings[i]!) : null,
      }));

      for (let i = 0; i < rows.length; i += EMBEDDING_BATCH_SIZE) {
        const { error } = await db.from(table("excerpts")).insert(rows.slice(i, i + EMBEDDING_BATCH_SIZE));
        if (error && !error.message.includes("duplicate")) throw new Error(error.message);
      }

      created = rows.length;
    } catch (err) {
      // §7.4: a source whose chunks could not be embedded is MARKED and
      // excluded from vector selection, but remains available for manual
      // inclusion with a visible note. It is never silently dropped.
      embedFailures++;
      await db
        .from(table("sources"))
        .update({
          embed_failed: true,
          embed_error: err instanceof Error ? err.message : String(err),
        })
        .eq("id", source.id);

      await logWarn(
        `"${source.title ?? "A source"}" could not be embedded, so it will not be picked automatically. You can still include it by hand.`,
        { requestId: request.id, step: "chunk_embed", detail: { error: String(err) } },
      );
    }
  }

  const remaining = pending.length - 1;
  return {
    sourcesProcessed: 1,
    excerptsCreated: created,
    embedFailures,
    complete: remaining === 0,
  };
}

// ─── Step: score (§7.5) ─────────────────────────────────────────────────────

/**
 * relevance_score per source = the maximum cosine similarity between any of
 * its excerpts and the embedded request. Sources below the threshold are shown
 * collapsed and unchecked, with the score visible. Nothing is auto-deleted.
 */
export async function stepScore(request: ContentRequest): Promise<{ scored: number }> {
  const db = serviceClient();

  const queryText = [request.idea, request.target_audience, request.primary_keyword]
    .filter(Boolean)
    .join("\n");

  const { embeddings } = await embed([queryText], "query", {
    requestId: request.id,
    step: "score",
  });

  const vector = embeddings[0];
  if (!vector) throw new Error("Could not embed the request, so sources cannot be ranked.");

  const { error } = await db.rpc("score_source_relevance", {
    p_request_id: request.id,
    p_embedding: toVectorLiteral(vector),
  });

  if (error) throw new Error(`Could not score source relevance: ${error.message}`);

  const { count } = await db
    .from(table("sources"))
    .select("id", { count: "exact", head: true })
    .eq("request_id", request.id)
    .not("relevance_score", "is", null);

  return { scored: count ?? 0 };
}

/** Rough pre-flight estimate shown before research begins (§6). */
export function estimateRequestCost(seedUrlCount: number, channelCount: number): number {
  const searchCents = seedUrlCount === 0 ? 4 : 0;
  const scrapeCents = Math.max(seedUrlCount, 6) * 0.1;
  const embedCents = 0.1;
  const planCents = 1;
  const draftCents = 5;
  const evalCents = 3.5;
  const reviseCents = 3;
  const adaptCents = channelCount * 0.35;

  return Math.ceil(
    searchCents + scrapeCents + embedCents + planCents + draftCents + evalCents + reviseCents + adaptCents,
  );
}

export { estimateTokens };
