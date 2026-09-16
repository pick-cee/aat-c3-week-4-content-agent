import "server-only";
import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import {
  FIRECRAWL_MAX_AGE_MS,
  MIN_MARKDOWN_CHARS,
  MAX_MARKDOWN_CHARS,
  FETCH_RETRY_ATTEMPTS,
  FETCH_RETRY_BASE_MS,
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
  /** True when Firecrawl served this from cache — a paid no-op avoided. */
  fromCache: boolean;
  creditsUsed: number;
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
export async function scrape(url: string): Promise<ScrapeResult> {
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

  let response: Response | null = null;
  let body: FirecrawlResponse | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= FETCH_RETRY_ATTEMPTS; attempt++) {
    try {
      response = await fetch(SCRAPE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.firecrawl.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          formats: ["markdown"],
          onlyMainContent: true,
          // Re-scraping a page we read last week is a paid no-op (§7.3, §18.4).
          maxAge: FIRECRAWL_MAX_AGE_MS,
          timeout: 45_000,
          blockAds: true,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      // Retries are two attempts with exponential backoff and jitter, on 429
      // and 5xx ONLY. A 404 is not retried, because retrying a 404 is spending
      // money to be told the same thing (§7.3).
      if (response.status === 429 || response.status >= 500) {
        lastError = `Firecrawl returned ${response.status}`;
        if (attempt < FETCH_RETRY_ATTEMPTS) {
          await sleep(FETCH_RETRY_BASE_MS * 2 ** attempt + Math.random() * 400);
          continue;
        }
        return {
          ...base,
          httpStatus: response.status,
          status: "fetch_failed",
          error:
            response.status === 429
              ? "Rate limited by the scraping service after two retries."
              : `The scraping service returned ${response.status} after two retries.`,
          retryable: true,
        };
      }

      body = (await response.json()) as FirecrawlResponse;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      if (attempt < FETCH_RETRY_ATTEMPTS) {
        await sleep(FETCH_RETRY_BASE_MS * 2 ** attempt + Math.random() * 400);
        continue;
      }
      return {
        ...base,
        status: "fetch_failed",
        error: isTimeout
          ? "The page took too long to fetch and timed out after two retries."
          : `Could not reach the scraping service: ${lastError}`,
        retryable: true,
      };
    }
  }

  if (!body) {
    return {
      ...base,
      status: "fetch_failed",
      error: lastError ?? "The scraping service returned no response.",
      retryable: true,
    };
  }

  const metadata = body.data?.metadata ?? {};
  const httpStatus = metadata.statusCode ?? response?.status ?? null;
  const finalUrl = metadata.sourceURL ?? metadata.url ?? null;

  const enriched = {
    ...base,
    httpStatus,
    title: metadata.title?.trim() || null,
    siteName: metadata.siteName ?? metadata.ogSiteName ?? null,
    author: metadata.author ?? null,
    publishedAt: normaliseDate(metadata.publishedTime ?? metadata.articlePublishedTime),
    fromCache: metadata.cached === true,
    creditsUsed: metadata.creditsUsed ?? (metadata.cached ? 0 : 1),
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
