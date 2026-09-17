import "server-only";
import { serviceClient, table } from "@/lib/db/client";
import { logInfo, logWarn, logError } from "@/lib/log";
import { scrape, isUsableSource } from "@/lib/providers/firecrawl";
import { callWithSearch } from "@/lib/providers/anthropic";
import { embed, toVectorLiteral, EmbeddingError } from "@/lib/providers/embeddings";
import { chunkMarkdown } from "./chunking";
import { priceScrapes, recordModelCall, assertWithinBudget, BudgetExceededError } from "@/lib/cost";
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

  outcome: "ok" | "no_sources_found";
}

export async function stepDiscover(request: ContentRequest): Promise<DiscoverResult> {
  const db = serviceClient();
  const seedUrls = request.seed_urls ?? [];
  let seeded = seedUrls.length;
  for (const url of seedUrls) {
    if (!isValidUrl(url)) continue;
    await insertSource(request.id, url, "seed", null);
  }
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
            "Return 5 to 6 strong results, expect some to be unreadable, so breadth " +
            "matters. `confidence` is 0 to 1. Every url must be one you " +
            "actually saw in a search result, do not construct or guess a URL.",
        },
      ],
      prompt: buildDiscoveryPrompt(request, seedUrls),
    });

    queries = result.queries;

    const verifiedUrls = new Set(result.citedUrls.map(url => canonicaliseUrl(url)));
    for (const item of (result.value ?? []).slice(0, 6)) {
      if (!item?.url || !isValidUrl(item.url)) continue;
      if (!verifiedUrls.has(canonicaliseUrl(item.url))) continue;
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
    if (err instanceof BudgetExceededError) throw err;
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


function wantsTopUp(request: ContentRequest): boolean {
  return /\b(additional sources|more sources|search the web|find more|expand the research)\b/i.test(
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
  if (error) {
    if (error.code === "23505") return false;
    throw new Error(`Could not save a source: ${error.message}`);
  }
  return true;
}

export interface FetchStepResult {
  attempted: number;
  succeeded: number;
  failed: number;
  remaining: number;

  complete: boolean;
}


export async function stepFetch(request: ContentRequest): Promise<FetchStepResult> {
  const db = serviceClient();

  const { data: pending, error: pendingError } = await db
    .from(table("sources"))
    .select("id, url, url_canonical")
    .eq("request_id", request.id)
    .eq("fetch_status", "pending")
    .limit(FETCH_BATCH_SIZE);

  if (pendingError) throw new Error(`Could not load sources: ${pendingError.message}`);
  if (!pending || pending.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, remaining: 0, complete: true };
  }

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += FETCH_CONCURRENCY) {
    const batch = pending.slice(i, i + FETCH_CONCURRENCY);

    const fetched = await Promise.allSettled(
      batch.map(async (source) => {
        const result = await scrape(source.url as string, request.id);

        const { error: saveError } = await db
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
            included: isUsableSource(result.status),
          })
          .eq("id", source.id as string);

        if (saveError) throw new Error(saveError.message);
        if (isUsableSource(result.status)) succeeded++;
        else failed++;
      }),
    );
    const failure = fetched.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
  }

  const { count: remaining, error: remainingError } = await db
    .from(table("sources"))
    .select("id", { count: "exact", head: true })
    .eq("request_id", request.id)
    .eq("fetch_status", "pending");

  if (remainingError) throw new Error("Could not check unread sources: " + remainingError.message);
  return {
    attempted: pending.length,
    succeeded,
    failed,
    remaining: remaining ?? 0,
    complete: (remaining ?? 0) === 0,
  };
}


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


  const { data: failedRows } = await db
    .from(table("sources"))
    .select("id, embed_retryable")
    .eq("request_id", request.id)
    .eq("embed_failed", true);

  const failed = (failedRows ?? []) as Pick<Source, "id" | "embed_retryable">[];
  const embedFailed = failed.length;
  const embedPending = failed.filter((s) => s.embed_retryable).length;
  const rows = excerptRows ?? [];
  const bySource = new Map<string, number>();
  for (const row of rows) {
    const id = row.source_id as string;
    bySource.set(id, (bySource.get(id) ?? 0) + 1);
  }
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

export interface ChunkEmbedResult {
  sourcesProcessed: number;
  excerptsCreated: number;
  embedFailures: number;
  complete: boolean;
}


export type EmbedCandidate = Pick<
  Source,
  "id" | "embed_failed" | "embed_retryable" | "embed_attempts"
>;


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


export async function stepChunkEmbed(request: ContentRequest): Promise<ChunkEmbedResult> {
  const db = serviceClient();

  const { data: sources, error: sourcesError } = await db
    .from(table("sources"))
    .select("id, markdown, fetch_status, embed_failed, embed_retryable, embed_attempts, title")
    .eq("request_id", request.id)
    .in("fetch_status", ["ok", "too_large", "redirected_offsite"]);

  if (sourcesError) throw new Error(sourcesError.message);
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

  const { data: existing, error: existingError } = await db
    .from(table("excerpts"))
    .select("source_id")
    .eq("request_id", request.id);

  if (existingError) throw new Error(existingError.message);
  const counts = new Map<string, number>();
  for (const row of existing ?? []) counts.set(row.source_id, (counts.get(row.source_id) ?? 0) + 1);
  const done = new Set(candidates.filter(source => counts.get(source.id) === chunkMarkdown(source.markdown ?? "").length && counts.has(source.id)).map(s => s.id));

  const pending = selectPendingSources(candidates, done);

  if (pending.length === 0) {
    return { sourcesProcessed: 0, excerptsCreated: 0, embedFailures: 0, complete: true };
  }

  const source = pending[0]!;
  const attempt = source.embed_attempts + 1;
  let created = 0;
  let embedFailures = 0;

  let willRetry = false;

  const chunks = chunkMarkdown(source.markdown ?? "");

  if (chunks.length === 0) {
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

      // One insert is transactional: no partially indexed source can look done.
      if (counts.has(source.id)) {
        const { error } = await db.from(table("excerpts")).delete().eq("source_id",source.id);
        if (error) throw new Error(error.message);
      }
      const { error: insertError } = await db.from(table("excerpts")).insert(rows);
      if (insertError) throw new Error(insertError.message);

      created = rows.length;
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
      if (err instanceof BudgetExceededError) throw err;
      if (!(err instanceof EmbeddingError)) throw err;
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
      if (willRetry) throw err;
    }
  }


  const remaining = pending.length - (willRetry ? 0 : 1);
  return {
    sourcesProcessed: 1,
    excerptsCreated: created,
    embedFailures,
    complete: remaining === 0,
  };
}


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


export { estimateRequestCost } from "@/lib/intake";

export { estimateTokens };
