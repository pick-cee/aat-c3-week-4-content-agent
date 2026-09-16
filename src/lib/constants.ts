/**
 * Every threshold, price and limit in the system.
 *
 * DESIGN.md conventions: "Thresholds and prices are named constants in one
 * file, not literals scattered through the code." Prices change, and a stale
 * price is a wrong cost report — hence PRICES_VERIFIED_ON.
 */

// ─── Prices ─────────────────────────────────────────────────────────────────

/**
 * The date the prices below were last checked against the providers' own
 * pricing pages. If this is stale, every cost figure the system reports is a
 * guess wearing a decimal point.
 */
export const PRICES_VERIFIED_ON = "2026-09-14";

/** USD per million tokens. DESIGN.md §18.1. */
export const MODEL_PRICES = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
} as const;

export type ModelId = keyof typeof MODEL_PRICES;

/** Model assignment per task. DESIGN.md §18.2 — per task, not per project. */
export const MODELS = {
  /** Query planning + web_search. Light judgment; the search tool does the work. */
  discovery: "claude-haiku-4-5-20251001",
  /** Three angles from a digest. Short, schema-constrained. */
  planning: "claude-haiku-4-5-20251001",
  /** Publication-quality long-form prose. The largest token spend. */
  drafting: "claude-sonnet-5",
  /** Same class of work as drafting, on a smaller span. */
  revision: "claude-sonnet-5",
  /**
   * The judge reads one article and writes a paragraph, so judging costs about
   * a third of what writing costs. An extra cent buys more at the quality gate
   * than it does at the keyboard. DESIGN.md §18.2.
   */
  evaluation: "claude-opus-5",
  /** Four short outputs, explicit rules, low judgment. */
  adaptation: "claude-haiku-4-5-20251001",
  /** One sentence from a title. */
  altText: "claude-haiku-4-5-20251001",
} as const satisfies Record<string, ModelId>;

/** USD per search. Counts even when it returns nothing. DESIGN.md §18.1. */
export const WEB_SEARCH_PRICE_PER_SEARCH = 10 / 1000;

/** text-embedding-3-small, USD per million tokens. Same rate Voyage charged. */
export const EMBEDDING_PRICE_PER_MTOK = 0.02;

/** Firecrawl, USD per scrape credit. A cached scrape (maxAge) costs nothing. */
export const FIRECRAWL_PRICE_PER_CREDIT = 0.001;

// ─── Anthropic API ──────────────────────────────────────────────────────────

/** No beta header. DESIGN.md "API notes that will bite". */
export const WEB_SEARCH_TOOL_TYPE = "web_search_20260318" as const;

/** Searches for a raw-idea request. */
export const WEB_SEARCH_MAX_USES = 4;

/** Searches when seed URLs exist and the idea asks for more. DESIGN.md §7.2. */
export const WEB_SEARCH_MAX_USES_TOPUP = 2;

/** Content farms and our own domain, kept out of discovery. DESIGN.md §7.1. */
export const BLOCKED_SEARCH_DOMAINS = [
  "ezinearticles.com",
  "articlesbase.com",
  "hubpages.com",
  "buzzle.com",
  "examiner.com",
];

// ─── Embeddings ─────────────────────────────────────────────────────────────

/**
 * OpenAI rather than Voyage. Voyage's free tier rate-limits to a few requests
 * a minute, which did not fail loudly — it dropped six fetched articles from
 * the corpus and surfaced three steps later as "the angles are too similar".
 *
 * 512 dimensions is unchanged, so the pgvector column and every tuned
 * similarity threshold (§8.4) carry over. text-embedding-3-small is trained so
 * a shortened vector remains usable, which is why `dimensions` is a request
 * parameter rather than a slice of a 1536-wide result.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 512;
/** OpenAI accepts up to 2,048 inputs per request; 128 keeps payloads modest. */
export const EMBEDDING_BATCH_SIZE = 128;

/**
 * How many times chunk_embed will attempt one source before leaving it out.
 *
 * Each attempt already retries internally with a long backoff, so three
 * attempts spans several rate-limit windows. The cap exists so a provider that
 * is down for the entire run cannot spend every step invocation on the same
 * source while the others wait.
 */
export const MAX_EMBED_ATTEMPTS = 3;

// ─── Chunking. No model involved. DESIGN.md §5.5. ───────────────────────────

export const CHUNK_TARGET_TOKENS_MIN = 250;
export const CHUNK_TARGET_TOKENS_MAX = 400;
/** Rough chars-per-token for English markdown. Used for budgeting only. */
export const CHARS_PER_TOKEN = 4;

// ─── Fetching. DESIGN.md §7.3. ──────────────────────────────────────────────

/** Seven days. Re-scraping a page we read last week is a paid no-op. */
export const FIRECRAWL_MAX_AGE_MS = 604_800_000;
export const FETCH_CONCURRENCY = 4;
/** Below this, a 200 response is `empty`, not `ok`. */
export const MIN_MARKDOWN_CHARS = 400;
/** Above this, `too_large`: truncated, flagged, still used. */
export const MAX_MARKDOWN_CHARS = 200_000;
/** Two attempts with exponential backoff and jitter, on 429 and 5xx only. */
export const FETCH_RETRY_ATTEMPTS = 2;
export const FETCH_RETRY_BASE_MS = 1_000;

/** Tracking params stripped during canonicalisation. DESIGN.md §5.4. */
export const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "msclkid",
  "ref",
  "ref_src",
  "mc_cid",
  "mc_eid",
  "igshid",
  "_hsenc",
  "_hsmi",
];

/** Markers that mean a fetch returned a paywall rather than an article. */
export const PAYWALL_MARKERS = [
  "subscribe to continue",
  "subscribe to read",
  "this article is for subscribers",
  "become a member to read",
  "sign in to read the full",
  "you have reached your article limit",
  "create an account to continue reading",
];

/**
 * Pages that fetched successfully but are not articles.
 *
 * A GitLab sign-in page reached the corpus as a usable source, which left one
 * real article behind two "sources" and made "each angle must draw on two
 * distinct sources" unsatisfiable — planning then burned three attempts
 * failing the same check.
 *
 * `empty` catches a page with no text. This catches a page with plenty of
 * text, none of which is an article: a login wall, a cookie consent screen, a
 * 404 that returns 200. Matched against the OPENING of the content, where a
 * real article would already be making its point.
 */
export const NOT_AN_ARTICLE_MARKERS = [
  "sign in to",
  "sign in ·",
  "log in to",
  "create an account",
  "forgot your password",
  "enable javascript",
  "javascript is required",
  "please enable cookies",
  "checking your browser",
  "verify you are human",
  "access denied",
  "page not found",
  "404 not found",
  "this domain is for use in illustrative examples",
];

/**
 * A page shorter than this is treated as not-an-article when it also matches a
 * marker above. A long page containing "sign in to" is probably an article
 * that mentions signing in.
 */
export const NOT_AN_ARTICLE_MAX_CHARS = 2_500;

// ─── Research selection. DESIGN.md §7.5. ────────────────────────────────────

/** Below this, a source is shown collapsed and unchecked. Never auto-deleted. */
export const SOURCE_RELEVANCE_THRESHOLD = 0.25;

/**
 * One source is not research. A raw-idea request with fewer than this many
 * successful fetches stops rather than drafting on thin material.
 */
export const MIN_SOURCES_FOR_RESEARCH = 2;

// ─── Grounding. DESIGN.md §8.4. ─────────────────────────────────────────────

/**
 * Cosine similarity between a marked sentence and the excerpt it cites.
 * Marker integrity proves a citation exists; this proves the sentence has
 * something to do with it.
 *
 * DESIGN.md §24.2 lists these as needing tuning against the broken input pack
 * rather than guessing. `scripts/broken-input-pack.ts` includes a deliberately
 * mis-cited sentence so they are tuned against a real example.
 */
export const GROUNDING_STRONG_THRESHOLD = 0.45;
export const GROUNDING_WEAK_THRESHOLD = 0.3;

/** Fraction of marked sentences that may be weak before the draft revises. */
export const MAX_WEAK_CITATION_RATIO = 0.25;
/** Count of flagged-unsupported sentences that forces a revision. */
export const MAX_UNSUPPORTED_CLAIMS = 2;
/** Fraction of factual sentences that must carry a marker at all. */
export const MIN_MARKED_SENTENCE_RATIO = 0.6;

// ─── Drafting. DESIGN.md §8.2, §10. ─────────────────────────────────────────

/** Token cap on excerpts passed to the drafting call. A 60k pile becomes 12k. */
export const DRAFTING_EXCERPT_TOKEN_BUDGET = 12_000;
/** Top-k excerpts per outline section, by cosine similarity to its intent. */
export const EXCERPTS_PER_SECTION = 4;

export const ARTICLE_MIN_WORDS = 900;
export const ARTICLE_MAX_WORDS = 2_000;

/**
 * Output caps per generation step.
 *
 * These are a SAFETY RAIL against a runaway generation, not a budget. They are
 * deliberately far above what each step needs, because the failure they
 * prevent — a model stopping mid-sentence — is invisible in the output and
 * expensive to diagnose, while the cost of headroom is zero: you are billed
 * for tokens produced, never for the cap.
 *
 * Getting this wrong is what produced "the evaluation could not run: the model
 * hit its 4,000-token limit", a message no content manager should ever see. A
 * judged rubric with four reasoned criteria and a list of sections to revise
 * genuinely runs past 4,000 tokens on a long article; the cap was set by
 * guesswork rather than by what the step has to say.
 *
 * Verified against the API: 16,000 is accepted by Opus 5 and Sonnet 5 without
 * streaming, 8,000 by Haiku 4.5. The real ceiling is the ten-minute
 * non-streaming limit, not the token count.
 */
/**
 * Output ceilings per call, sized to MEASURED output rather than guessed.
 *
 * These were 8k-16k across the board, which is not free: a model asked for
 * room to write 16,000 tokens takes the time to consider writing them. Steps
 * were measured at 166s (evaluate), 142s (revise) and 141s (plan) against a
 * runner route that the platform kills at 60s, so on Vercel every one of them
 * would die mid-flight.
 *
 * Each ceiling is now roughly double the largest output that step has ever
 * produced, which leaves real headroom while cutting the time spent reaching
 * for it. `widenedLimit` still doubles these on a truncation retry, so an
 * unusually long piece is not lost, it simply costs a second call.
 *
 * Measured over 63 calls on 2026-09-16:
 *   revise    max 12,250  avg 9,356   ← the one that genuinely needs room
 *   draft     max  8,285  avg 3,037
 *   evaluate  max  4,441  avg 3,324
 *   discover  max  1,431
 *   adapt     max  1,415  avg   599
 *   plan      max  1,050  avg   910
 */
export const MAX_TOKENS = {
  /** A 2,000-word article with citation markers is ~4k; measured max 8,285. */
  drafting: 12_000,
  /** Replacement sections. Measured max 12,250: the largest output we produce. */
  revision: 14_000,
  /** Four criteria with reasoning plus a section list. Measured max 4,441. */
  evaluation: 8_000,
  /** Three angles with outlines and rationales. Measured max 1,050. */
  planning: 3_000,
  /** One short post, or a 600-word newsletter. Measured max 1,415. */
  adaptation: 3_000,
  /** Search results as JSON with reasoning. Measured max 1,431. */
  discovery: 3_000,
  /** A title, a meta description and keywords. */
  articleHeader: 2_000,
  /** One sentence. */
  altText: 1_000,
} as const;
export const META_DESCRIPTION_MAX_CHARS = 160;
/** SEO: keyword must appear inside this many opening words. */
export const KEYWORD_FIRST_N_WORDS = 100;
export const MIN_ARTICLE_LINKS = 2;
export const MAX_ARTICLE_LINKS = 3;
/** Paragraphs of 2–3 sentences; warns above this. DESIGN.md §10. */
export const MAX_SENTENCES_PER_PARAGRAPH = 4;

export const ANGLE_COUNT = 3;
export const ANGLE_OUTLINE_MIN_SECTIONS = 4;
export const ANGLE_OUTLINE_MAX_SECTIONS = 7;
/**
 * Two angles more similar than this are not a choice. DESIGN.md §9.
 *
 * Tuned against real output rather than guessed (§24.2 asks for exactly this).
 * Measured with voyage-3.5-lite over headline + outline:
 *
 *   · a myth-breaker, a how-to and a cost case — three genuinely different
 *     articles on one topic — score 72–79% against each other
 *   · three rephrasings of "cleaning services save busy people time" score
 *     88–92%
 *
 * Embeddings of same-topic text sit high by construction, so 0.70 flagged
 * every set including the good ones, and a check that always fires is a check
 * nobody reads. 0.85 sits in the gap between the two populations.
 */
export const MAX_ANGLE_OVERLAP = 0.85;
export const MIN_SOURCES_PER_ANGLE = 2;

// ─── Evaluation and revision. DESIGN.md §11. ────────────────────────────────

/** Two rounds, then needs_human. It never loops. DESIGN.md §2.7. */
/**
 * Sections rewritten per revision invocation.
 *
 * Sized so one call fits inside the runner route's 60-second ceiling. Five
 * sections produced 12,250 tokens and 282 seconds; two is comfortably inside
 * the budget, and anything left over is handled by the next round rather than
 * by a step the platform kills half way through.
 */
export const MAX_SECTIONS_PER_REVISION = 2;

export const MAX_REVISION_ROUNDS = 2;
/** Each re-plan costs money and the button shows the amount. DESIGN.md §14.1. */
export const MAX_REPLANS_BEFORE_CONFIRM = 2;

// ─── Channel format rules. DESIGN.md §12.1. ─────────────────────────────────

export const CHANNEL_LIMITS = {
  linkedin: {
    maxChars: 3_000,
    maxLinesPerParagraph: 3,
    maxEmoji: 5,
  },
  x: {
    maxChars: 280,
    /** A URL weighs this regardless of real length. Twitter counts t.co. */
    urlWeight: 23,
    /** Most emoji and CJK characters weigh 2. */
    wideCharWeight: 2,
    minHashtags: 1,
    maxHashtags: 2,
  },
  newsletter: {
    maxSubjectChars: 65,
    minWords: 250,
    maxWords: 600,
    minIntroSentences: 1,
    maxIntroSentences: 3,
    minSubheadings: 2,
  },
} as const;

/** The three channels the brief names. */
export const ALL_CHANNELS = ["linkedin", "x", "newsletter"] as const;
export type Channel = (typeof ALL_CHANNELS)[number];

/**
 * Which channels the system sends itself, and which it hands to a person.
 * The publish worker branches on the connector row's `kind`, never on these —
 * if LinkedIn access is ever obtained it becomes `delivering` by changing one
 * row. DESIGN.md §5.13, §15.1.
 */
export const CHANNEL_DEFAULT_KIND = {
  linkedin: "handoff",
  x: "handoff",
  newsletter: "delivering",
} as const satisfies Record<Channel, "delivering" | "handoff">;

/**
 * Retries per channel before it is marked format_failed (that channel only —
 * one broken channel never blocks the others, §12.1).
 *
 * Two rather than one. An over-long X post converges: told it weighed 470 and
 * the limit is 280, the next attempt came back at 320 — closer, still over,
 * and out of retries. A second retry lands it. Each is a few hundred Haiku
 * tokens, which is cheaper than a channel a human has to rewrite by hand.
 */
export const CHANNEL_FORMAT_RETRIES = 2;

// ─── Images. DESIGN.md §13. ─────────────────────────────────────────────────

export const ALT_TEXT_MAX_CHARS = 125;
export const IMAGE_CANDIDATE_COUNT = 6;

// ─── Publishing. DESIGN.md §15. ─────────────────────────────────────────────

export const PUBLISH_MAX_ATTEMPTS = 3;
/** Items claimed per cron invocation, then it returns and waits. §15.2. */
export const PUBLISH_BATCH_SIZE = 10;
/** In `publishing` longer than this → `uncertain`. Never auto-retried. §15.5. */
export const PUBLISH_STUCK_MINUTES = 5;
/** A handoff unposted this long after its slot re-notifies once. §15.4. */
export const HANDOFF_REMINDER_HOURS = 2;
/** Refresh a connector token when it expires within this. §15.1. */
export const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** The one URL a stranger could act on, so it expires. §15.4. */
export const HANDOFF_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── The step runner. DESIGN.md §3.1. ───────────────────────────────────────

/**
 * How long a claimed request stays claimed. No row from the claim means
 * another runner holds it.
 *
 * Tied to `maxDuration` on the runner route, which is what actually bounds a
 * step: the platform kills the function at 60 seconds, so no live step can
 * still be working after that. The lease is a little longer to cover the
 * response and the release write, and no longer.
 *
 * Both extremes hurt, and this build has now had each:
 *
 *   TOO SHORT (90s) and the lease expired under a planning step still making
 *   its third model call, so a second runner claimed the same request and
 *   raced it.
 *
 *   TOO LONG (300s) and a runner that DIED — a dev server restart, a crashed
 *   function — held the request for five minutes while the UI said "another
 *   worker is already advancing this request" and nothing was.
 *
 * A dead worker's claim has to expire quickly, because nothing else releases
 * it. Anything longer than the function can live is time a person spends
 * staring at a lie.
 */
export const RUNNER_LEASE_SECONDS = 75;
/** Then the request stops at `failed` naming the step, not an infinite retry. */
export const MAX_STEP_ATTEMPTS = 3;
/** URLs per `fetch` invocation, sized to fit the function budget. §3.1. */
export const FETCH_BATCH_SIZE = 4;

// ─── Spending controls. DESIGN.md §18.4. ────────────────────────────────────

export const DEFAULT_BUDGET_CENTS = 150;
export const MAX_SEED_URLS = 10;
/** Rejected in the form, before anything is spent. DESIGN.md §6. */
export const MIN_IDEA_CHARS = 15;
export const MAX_IDEA_CHARS = 2_000;
