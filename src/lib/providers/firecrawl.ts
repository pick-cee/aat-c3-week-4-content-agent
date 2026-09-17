import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { priceScrapes, reserveModelCall, recordModelCall } from "@/lib/cost";
import { env } from "@/lib/env";
import { serviceClient, table } from "@/lib/db/client";
import {
  FIRECRAWL_MAX_AGE_MS,
  MIN_MARKDOWN_CHARS,
  MAX_MARKDOWN_CHARS,
  PAYWALL_MARKERS,
  NOT_AN_ARTICLE_MARKERS,
  NOT_AN_ARTICLE_MAX_CHARS,
} from "@/lib/constants";
import { registrableDomain } from "@/lib/text";
import type { FetchStatus } from "@/lib/db/types";

/**
 * Firecrawl does the reading for every URL that matters, including URLs the
 * manager supplied. One ingestion path, one cache, one excerpt table (§2.4).
 *
 * The point of this module is the status mapping in §7.3. A source that could
 * not be read is a ROW with a status and a reason, never an absence — `empty`
 * (fetched, nothing there) and `fetch_failed` (never fetched) are different
 * values, because a dead fetch and a genuinely empty result producing the same
 * message was useless in Week 2 (§5.4).
 */

const SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

export interface ScrapeResult {
  status: FetchStatus;
  markdown: string | null;
  title: string | null;
  siteName: string | null;
  author: string | null;
  publishedAt: string | null;
  httpStatus: number | null;
  /** A plain-language reason a non-engineer can read. Null when status is ok. */
  error: string | null;
  contentHash: string | null;
  markdownChars: number;
  /** Provider cache hits still consume a scrape credit. */
  fromCache: boolean;
  creditsUsed: number;
  creditsKnown?: boolean;
  /** Set when the final URL left the registrable domain we asked for. */
  finalUrl: string | null;
  /** Whether retrying this could plausibly help (§17). */
  retryable: boolean;
}

interface FirecrawlResponse {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      language?: string;
      sourceURL?: string;
      url?: string;
      statusCode?: number;
      error?: string;
      siteName?: string;
      ogSiteName?: string;
      author?: string;
      publishedTime?: string;
      articlePublishedTime?: string;
      contentType?: string;
      cached?: boolean;
      creditsUsed?: number;
    };
  };
}

/**
 * Scrapes one URL and maps the outcome onto a `fetch_status`.
 *
 * Never throws for a page-level problem: a 404, a paywall and an empty shell
 * all return a result whose status says which. It throws only when the
 * Firecrawl API itself is unusable, because that is a system failure rather
 * than a fact about the page.
 */
export class ScrapeProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly usageKnown = false) { super(message); this.name = "ScrapeProviderError"; }
}

export async function scrape(url: string, requestId?: string): Promise<ScrapeResult> {
  void env.firecrawl.apiKey;
  const inputHash = createHash("sha256").update(JSON.stringify({ url, contract: "basic-pdf5-v1" })).digest("hex");
  if (requestId) {
    const { data, error } = await serviceClient().from(table("model_calls")).select("response_json")
      .eq("request_id", requestId).eq("input_hash", inputHash).eq("model", "firecrawl")
      .eq("outcome", "used").not("response_json", "is", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error("Could not read the saved source response: " + error.message);
    if (data?.response_json) return data.response_json as unknown as ScrapeResult;
  }
  const id = randomUUID(), ceiling = priceScrapes(6), started = Date.now();
  if (requestId) await reserveModelCall(id, requestId, "fetch", "firecrawl", ceiling);
  let result: ScrapeResult;
  try { result = await fetchPage(url); }
  catch (error) {
    if (requestId) await recordModelCall({ id, requestId, step: "fetch", model: "firecrawl", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "failed", usageKnown: error instanceof ScrapeProviderError && error.usageKnown, costCentsOverride: 0, costCeilingCents: error instanceof ScrapeProviderError && error.usageKnown ? 0 : ceiling, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started });
    throw error;
  }
  if (requestId) await recordModelCall({ id, requestId, step: "fetch", model: "firecrawl", purpose: "Read source page", usage: { inputTokens: 0, outputTokens: 0 }, outcome: "used", costCentsOverride: priceScrapes(result.creditsUsed), usageKnown: result.creditsKnown !== false, costCeilingCents: result.creditsKnown === false ? ceiling : 0, latencyMs: Date.now() - started, inputHash, response: result.retryable ? undefined : result });
  return result;
}

async function fetchPage(url: string): Promise<ScrapeResult> {
  const base: Omit<ScrapeResult, "status" | "error" | "retryable"> = {
    markdown: null,
    title: null,
    siteName: null,
    author: null,
    publishedAt: null,
    httpStatus: null,
    contentHash: null,
    markdownChars: 0,
    fromCache: false,
    creditsUsed: 0,
    finalUrl: null,
  };

  let response: Response;
  try {
    response = await fetch(SCRAPE_URL, {
      method: "POST", headers: { Authorization: "Bearer " + env.firecrawl.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, maxAge: FIRECRAWL_MAX_AGE_MS,
        timeout: 25_000, blockAds: true, proxy: "basic", skipTlsVerification: false,
        parsers: [{ type: "pdf", maxPages: 5 }] }),
      signal: AbortSignal.timeout(35_000),
    });
  } catch (error) {
    throw new ScrapeProviderError(error instanceof Error ? error.message : "The scraping service could not be reached.", true);
  }
  if (!response.ok) throw new ScrapeProviderError("The scraping service returned HTTP " + response.status, response.status === 408 || response.status === 429 || response.status >= 500, response.status >= 400 && response.status < 500 && response.status !== 408);
  const body = await response.json() as FirecrawlResponse;
  const metadata = body.data?.metadata ?? {};
  const httpStatus = metadata.statusCode ?? response?.status ?? null;
  const finalUrl = metadata.sourceURL ?? metadata.url ?? null;
  const isPdf = metadata.contentType?.toLowerCase().includes("pdf") || /\.pdf(?:[?#]|$)/i.test(finalUrl ?? url) || /\.pdf(?:[?#]|$)/i.test(url);

  const enriched = {
    ...base,
    httpStatus,
    title: metadata.title?.trim() || null,
    siteName: metadata.siteName ?? metadata.ogSiteName ?? null,
    author: metadata.author ?? null,
    publishedAt: normaliseDate(metadata.publishedTime ?? metadata.articlePublishedTime),
    fromCache: metadata.cached === true,
    creditsUsed: metadata.creditsUsed ?? (isPdf ? 0 : 1),
    creditsKnown: metadata.creditsUsed != null || !isPdf,
    finalUrl,
  };

  // ── The status mapping table from §7.3 ──

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      ...enriched,
      status: "paywalled",
      error: `The page refused access (HTTP ${httpStatus}). It is probably behind a paywall or a login.`,
      retryable: false,
    };
  }

  if (httpStatus === 404 || httpStatus === 410) {
    return {
      ...enriched,
      status: "fetch_failed",
      error: `The page does not exist (HTTP ${httpStatus}).`,
      // Retrying a 404 is spending money to be told the same thing.
      retryable: false,
    };
  }

  const contentType = metadata.contentType?.toLowerCase() ?? "";
  if (contentType && !/(html|pdf|text|xml|json)/.test(contentType)) {
    return {
      ...enriched,
      status: "unsupported_type",
      error: `The URL is ${contentType}, which is not a readable document.`,
      retryable: false,
    };
  }

  if (body.success === false || (!body.data?.markdown && body.error)) {
    return {
      ...enriched,
      status: "fetch_failed",
      error: body.error ?? metadata.error ?? "The scraping service could not read the page.",
      retryable: true,
    };
  }

  let markdown = body.data?.markdown ?? "";

  // A paywall that returns 200 with a teaser is the common case, and it is
  // detectable in the content rather than the status code.
  const opening = markdown.slice(0, 3_000).toLowerCase();
  if (markdown.length < 3_000 && PAYWALL_MARKERS.some((marker) => opening.includes(marker))) {
    return {
      ...enriched,
      markdown: markdown || null,
      markdownChars: markdown.length,
      status: "paywalled",
      error: "The page returned a subscription prompt instead of the article.",
      retryable: false,
    };
  }

  /**
   * Fetched, plenty of text, but not an article.
   *
   * A GitLab sign-in page passed every check above — it is not empty, not a
   * paywall, and returns 200 — so it entered the corpus as a usable source.
   * That left one real article standing behind two "sources", which made the
   * two-sources-per-angle rule unsatisfiable and cost three planning attempts.
   *
   * Reported as `empty` rather than a new status: from the reviewer's point of
   * view it is the same fact — the page was read and had no article on it.
   */
  const firstLines = markdown.slice(0, 1_500).toLowerCase();
  if (
    markdown.length < NOT_AN_ARTICLE_MAX_CHARS &&
    NOT_AN_ARTICLE_MARKERS.some((marker) => firstLines.includes(marker))
  ) {
    return {
      ...enriched,
      markdown: markdown || null,
      markdownChars: markdown.length,
      status: "empty",
      error:
        "The page was fetched but is not an article, it looks like a sign-in page, " +
        "a consent screen or a placeholder.",
      retryable: false,
    };
  }

  // Fetched, but nothing there. DISTINCT from fetch_failed: this page exists
  // and we read it; it is a nav shell or a stub (§5.4, §21.1).
  if (markdown.trim().length < MIN_MARKDOWN_CHARS) {
    return {
      ...enriched,
      markdown: markdown || null,
      markdownChars: markdown.length,
      status: "empty",
      error: `The page was fetched successfully but contained only ${markdown.trim().length} characters of article text.`,
      retryable: false,
    };
  }

  let status: FetchStatus = "ok";
  let error: string | null = null;

  // Truncated, flagged, and STILL USED (§7.3).
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    markdown = markdown.slice(0, MAX_MARKDOWN_CHARS);
    status = "too_large";
    error = `The page was longer than ${MAX_MARKDOWN_CHARS.toLocaleString()} characters and was truncated. It is still being used.`;
  }

  // Kept and flagged — a redirect off-domain may be legitimate syndication or
  // may be a parked domain, and that is a judgment for the reviewer (§7.3).
  if (finalUrl && registrableDomain(finalUrl) !== registrableDomain(url)) {
    status = "redirected_offsite";
    error = `This URL redirected to ${registrableDomain(finalUrl)}, a different site. It is still being used.`;
  }

  return {
    ...enriched,
    status,
    error,
    markdown,
    markdownChars: markdown.length,
    contentHash: createHash("sha256").update(markdown).digest("hex"),
    retryable: false,
  };
}

function normaliseDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Human-readable label for a fetch status. Used at gate one and on the public
 * source list, where both failures and successes appear — a source that could
 * not be read is shown, not hidden (§5.4).
 */
export function describeFetchStatus(status: FetchStatus): string {
  switch (status) {
    case "pending": return "Not fetched yet";
    case "ok": return "Read successfully";
    case "fetch_failed": return "Could not be fetched";
    case "blocked": return "Blocked by the site";
    case "paywalled": return "Behind a paywall";
    case "empty": return "Fetched, but had no article text";
    case "too_large": return "Very long, truncated, still used";
    case "unsupported_type": return "Not a readable document";
    case "redirected_offsite": return "Redirected to another site, still used";
  }
}

/** Whether this status still contributes material to a draft. */
export function isUsableSource(status: FetchStatus): boolean {
  return status === "ok" || status === "too_large" || status === "redirected_offsite";
}
