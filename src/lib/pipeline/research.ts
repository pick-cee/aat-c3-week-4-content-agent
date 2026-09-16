import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn, logError } from "@/lib/log";
import { scrape, isUsableSource } from "@/lib/providers/firecrawl";
import { callWithSearch } from "@/lib/providers/anthropic";
import { embed, toVectorLiteral, EmbeddingError } from "@/lib/providers/embeddings";
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
  MAX_EMBED_ATTEMPTS,
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
            /**
             * Roughly half of what a search returns cannot be read: pages
             * behind a login, sites that block scrapers, single-page apps that
             * render nothing server-side, placeholders. A run that asked for
             * 3-8 came back with 7 and ended up with ONE real article, which
             * made everything downstream fail.
             *
             * Naming the failure modes is what moves the number, not asking
             * for more results.
             */
            "IMPORTANT, many pages cannot be read once fetched, so choose for " +
            "READABILITY as well as relevance:\n" +
            "- Prefer pages that render their article as plain HTML.\n" +
            "- AVOID anything behind a sign-in: GitLab, Jira, Notion, Google Docs, " +
            "  LinkedIn posts, Facebook, X/Twitter, Medium member-only stories.\n" +
            "- AVOID PDFs, video pages, and sites that are mostly an app shell.\n" +
            "- Prefer documentation sites, company engineering blogs, research " +
            "  organisations, government and standards bodies, and established " +
            "  publications.\n\n" +
            "Reply with ONLY a fenced JSON block, no prose before or after:\n" +
            "```json\n" +
            '[{"url": "...", "title": "...", "why": "one line on what this contributes", ' +
            '"confidence": 0.0}]\n' +
            "```\n" +
            "Return 8 to 12 results, expect several to be unreadable, so breadth " +
            "matters. `confidence` is 0 to 1. Every url must be one you " +
            "actually saw in a search result, do not construct or guess a URL.",
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
      reason:
        `Only ${usable} of ${rows.length} pages could be read. One source is not research, ` +
        `so this stopped rather than writing an article that rests on a single page.`,
    };
  }

  return { ok: true, usable, failed };
}

/**
 * Whether there is enough MATERIAL to write from, judged after indexing.
 *
 * `assessResearch` runs on fetch status, before anything has been chunked, so
 * a page that fetched cleanly still counts even if it turns out to hold
 * nothing usable. That is how a run reached planning with one real article and
 * a GitLab sign-in page behind it: two "sources" by status, one source in
 * substance, and every downstream step then failed on material that was never
 * there.
 *
 * The honest place to stop is here — before spending on planning, drafting and
 * evaluation — with a reason a person can act on. §7.3: "If fewer than two
 * fetch successfully and the request had no seed URLs, it stops. One source is
 * not research."
 */
export async function assessMaterial(request: ContentRequest): Promise<{
  ok: boolean;
  sourcesWithContent: number;
  excerpts: number;
  reason?: string;
}> {
  const db = serviceClient();

  const { data: excerptRows } = await db
    .from(table("excerpts"))
    .select("id, source_id")
    .eq("request_id", request.id);

  /**
   * Sources that were read but could not be indexed.
   *
   * This is the case that hid for a whole run: six articles of 20k–36k
   * characters fetched perfectly, the embedding provider rate-limited every
   * batch, and the only visible symptom three steps later was "the angles are
   * too similar". Naming the real cause here is the difference between a
   * five-minute fix and an afternoon.
   */
  const { data: failedRows } = await db
    .from(table("sources"))
    .select("id, embed_retryable")
    .eq("request_id", request.id)
    .eq("embed_failed", true);

  const failed = (failedRows ?? []) as Pick<Source, "id" | "embed_retryable">[];
  const embedFailed = failed.length;
  // Still queued for another automatic attempt, as opposed to given up on.
  const embedPending = failed.filter((s) => s.embed_retryable).length;
  const rows = excerptRows ?? [];
  const bySource = new Map<string, number>();
  for (const row of rows) {
    const id = row.source_id as string;
    bySource.set(id, (bySource.get(id) ?? 0) + 1);
  }

  // A source contributing a single chunk is a stub, not a reference. Counting
  // it inflates "how much did we find" and is what made the numbers look fine
  // while the corpus was empty.
  const substantial = [...bySource.values()].filter((count) => count >= 2).length;
  const hadSeeds = (request.seed_urls ?? []).length > 0;

  if (rows.length === 0) {
    return {
      ok: false,
      sourcesWithContent: 0,
      excerpts: 0,
      reason:
        "The pages were fetched but none of them produced usable text, so there is nothing " +
        "to write from. Adding a source URL usually fixes this.",
    };
  }

  if (substantial === 0) {
    return {
      ok: false,
      sourcesWithContent: substantial,
      excerpts: rows.length,
      reason:
        "No source produced more than a fragment of text. An article written from this would " +
        "be padding rather than research, add a source URL and try again.",
    };
  }

  if (substantial < MIN_SOURCES_FOR_RESEARCH && !hadSeeds) {
    // When indexing is what starved it, say THAT. "Add a source URL" is
    // useless advice if the pages were found and simply could not be indexed.
    if (embedFailed > 0) {
      const plural = embedFailed === 1 ? "" : "s";
      const were = embedFailed === 1 ? "was" : "were";
      return {
        ok: false,
        sourcesWithContent: substantial,
        excerpts: rows.length,
        reason:
          embedPending > 0
            ? `${embedFailed} source${plural} ${were} read successfully but ${
                embedFailed === 1 ? "has" : "have"
              } not been indexed yet, because the embedding service is rate limiting us. ` +
              `This retries on its own, press Retry in a minute and the material should be there. ` +
              `Nothing is wrong with the research itself.`
            : `${embedFailed} source${plural} ${were} read successfully but could not be indexed ` +
              `after several attempts. The pages are still listed and you can include them by ` +
              `hand; otherwise add a source URL and try again.`,
      };
    }

    return {
      ok: false,
      sourcesWithContent: substantial,
      excerpts: rows.length,
      reason:
        `Only ${substantial} of the pages found held enough material to write from. One source ` +
        `is not research, so this stopped rather than producing three near-identical angles ` +
        `from a single page. Add a source URL, or try a broader idea.`,
    };
  }

  return { ok: true, sourcesWithContent: substantial, excerpts: rows.length };
}

// ─── Step: chunk_embed (§7.4) ───────────────────────────────────────────────

export interface ChunkEmbedResult {
  sourcesProcessed: number;
  excerptsCreated: number;
  embedFailures: number;
  complete: boolean;
}

/** The fields the pending decision actually turns on. */
export type EmbedCandidate = Pick<
  Source,
  "id" | "embed_failed" | "embed_retryable" | "embed_attempts"
>;

/**
 * Which sources still need indexing, in the order to attempt them.
 *
 * A source is pending when it has no excerpts AND we have not given up on it.
 * Giving up means one of two things: the failure was permanent (no chunks to
 * embed — retrying cannot change that), or it was transient but has already
 * used its attempts. Anything else comes back around, because the common
 * transient failure here is a per-minute rate limit that clears on its own.
 *
 * Ordering matters as much as the filter. Sources that have never been tried
 * go first, so one article stuck retrying cannot hold up five that would
 * succeed immediately.
 *
 * Pure and exported so the rule can be tested directly: when this was inline
 * it excluded every failed source forever, and nothing caught it.
 */
export function selectPendingSources<T extends EmbedCandidate>(
  candidates: T[],
  indexed: Set<string>,
): T[] {
  return candidates
    .filter((s) => {
      if (indexed.has(s.id)) return false;
      if (!s.embed_failed) return true;
      return s.embed_retryable && s.embed_attempts < MAX_EMBED_ATTEMPTS;
    })
    .sort((a, b) => a.embed_attempts - b.embed_attempts);
}

/**
 * Chunks and embeds one source per invocation, so a long page cannot blow the
 * function budget. Resumable: a source that already has excerpts is skipped.
 */
export async function stepChunkEmbed(request: ContentRequest): Promise<ChunkEmbedResult> {
  const db = serviceClient();

  const { data: sources } = await db
    .from(table("sources"))
    .select("id, markdown, fetch_status, embed_failed, embed_retryable, embed_attempts, title")
    .eq("request_id", request.id)
    .in("fetch_status", ["ok", "too_large", "redirected_offsite"]);

  const candidates = (sources ?? []) as Pick<
    Source,
    | "id"
    | "markdown"
    | "fetch_status"
    | "embed_failed"
    | "embed_retryable"
    | "embed_attempts"
    | "title"
  >[];

  const { data: existing } = await db
    .from(table("excerpts"))
    .select("source_id")
    .eq("request_id", request.id);

  const done = new Set((existing ?? []).map((r) => r.source_id as string));

  const pending = selectPendingSources(candidates, done);

  if (pending.length === 0) {
    return { sourcesProcessed: 0, excerptsCreated: 0, embedFailures: 0, complete: true };
  }

  const source = pending[0]!;
  const attempt = source.embed_attempts + 1;
  let created = 0;
  let embedFailures = 0;
  /** Set when this source failed in a way that brings it back around. */
  let willRetry = false;

  const chunks = chunkMarkdown(source.markdown ?? "");

  if (chunks.length === 0) {
    // Permanent: the text is not going to appear on a later attempt.
    await db
      .from(table("sources"))
      .update({
        embed_failed: true,
        embed_retryable: false,
        embed_attempts: attempt,
        embed_error: "The page produced no chunks to embed.",
      })
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

      // A source that failed earlier and has now succeeded must lose the flag,
      // or gate one keeps showing a failure note for a source that is indexed.
      if (source.embed_failed) {
        await db
          .from(table("sources"))
          .update({
            embed_failed: false,
            embed_retryable: false,
            embed_attempts: attempt,
            embed_error: null,
          })
          .eq("id", source.id);
      }
    } catch (err) {
      // §7.4: a source whose chunks could not be embedded is MARKED and
      // excluded from vector selection, but remains available for manual
      // inclusion with a visible note. It is never silently dropped.
      //
      // Whether it is also RETRIED turns on the provider's own answer: a 429 or
      // a 5xx is a statement about this minute, not about this page.
      embedFailures++;

      const retryable = err instanceof EmbeddingError && err.retryable;
      const exhausted = attempt >= MAX_EMBED_ATTEMPTS;
      willRetry = retryable && !exhausted;

      await db
        .from(table("sources"))
        .update({
          embed_failed: true,
          embed_retryable: retryable && !exhausted,
          embed_attempts: attempt,
          embed_error: err instanceof Error ? err.message : String(err),
        })
        .eq("id", source.id);

      const name = `"${source.title ?? "A source"}"`;
      await logWarn(
        retryable && !exhausted
          ? `${name} could not be indexed yet because the embedding service is rate limiting us. It will be tried again automatically.`
          : `${name} could not be embedded, so it will not be picked automatically. You can still include it by hand.`,
        {
          requestId: request.id,
          step: "chunk_embed",
          detail: { error: String(err), attempt, retryable },
        },
      );
    }
  }

  /**
   * This source counts as finished only if it will not come back around. A
   * retryable failure leaves it pending, so reporting `complete` here would
   * move the pipeline on with the source still unindexed — the exact bug this
   * change exists to fix, one level up.
   *
   * The attempt cap is what guarantees this terminates: every pass either
   * indexes a source or increments its attempt count toward MAX_EMBED_ATTEMPTS.
   */
  const remaining = pending.length - (willRetry ? 0 : 1);
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
