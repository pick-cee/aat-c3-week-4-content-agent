

export const PRICES_VERIFIED_ON = "2026-09-16";


export const MODEL_PRICES = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
} as const;

export type ModelId = keyof typeof MODEL_PRICES;


export const MODELS = {

  discovery: "claude-haiku-4-5-20251001",

  planning: "claude-haiku-4-5-20251001",

  drafting: "claude-sonnet-5",

  revision: "claude-sonnet-5",

  evaluation: "claude-sonnet-5",

  adaptation: "claude-haiku-4-5-20251001",

  altText: "claude-haiku-4-5-20251001",
} as const satisfies Record<string, ModelId>;


export const WEB_SEARCH_PRICE_PER_SEARCH = 10 / 1000;


export const EMBEDDING_PRICE_PER_MTOK = 0.02;


export const FIRECRAWL_PRICE_PER_CREDIT = 0.001;

export const WEB_SEARCH_TOOL_TYPE = "web_search_20260318" as const;


export const WEB_SEARCH_MAX_USES = 2;


export const WEB_SEARCH_MAX_USES_TOPUP = 2;


export const BLOCKED_SEARCH_DOMAINS = [
  "ezinearticles.com",
  "articlesbase.com",
  "hubpages.com",
  "buzzle.com",
  "examiner.com",
];

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 512;

export const EMBEDDING_BATCH_SIZE = 128;


export const MAX_EMBED_ATTEMPTS = 3;
export const CHUNK_TARGET_TOKENS_MIN = 250;
export const CHUNK_TARGET_TOKENS_MAX = 400;

export const CHARS_PER_TOKEN = 4;

export const FIRECRAWL_MAX_AGE_MS = 604_800_000;
export const FETCH_CONCURRENCY = 4;

export const MIN_MARKDOWN_CHARS = 400;

export const MAX_MARKDOWN_CHARS = 200_000;

export const FETCH_RETRY_ATTEMPTS = 2;
export const FETCH_RETRY_BASE_MS = 1_000;


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


export const PAYWALL_MARKERS = [
  "subscribe to continue",
  "subscribe to read",
  "this article is for subscribers",
  "become a member to read",
  "sign in to read the full",
  "you have reached your article limit",
  "create an account to continue reading",
];


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


export const NOT_AN_ARTICLE_MAX_CHARS = 2_500;

export const SOURCE_RELEVANCE_THRESHOLD = 0.25;


export const MIN_SOURCES_FOR_RESEARCH = 2;

export const GROUNDING_STRONG_THRESHOLD = 0.45;
export const GROUNDING_WEAK_THRESHOLD = 0.3;


export const MAX_WEAK_CITATION_RATIO = 0.25;

export const MAX_UNSUPPORTED_CLAIMS = 2;

export const MIN_MARKED_SENTENCE_RATIO = 0.6;

export const DRAFTING_EXCERPT_TOKEN_BUDGET = 6_000;

export const EXCERPTS_PER_SECTION = 4;

export const ARTICLE_MIN_WORDS = 900;
export const ARTICLE_MAX_WORDS = 2_000;



export const MAX_TOKENS = {

  drafting: 5_500,

  revision: 3_000,

  evaluation: 1_600,

  planning: 2_400,

  adaptation: 2_000,

  discovery: 3_000,

  articleHeader: 400,

  altText: 250,
} as const;
export const META_DESCRIPTION_MAX_CHARS = 160;

export const KEYWORD_FIRST_N_WORDS = 100;
export const MIN_ARTICLE_LINKS = 2;
export const MAX_ARTICLE_LINKS = 3;

export const MAX_SENTENCES_PER_PARAGRAPH = 4;

export const ANGLE_COUNT = 3;
export const ANGLE_OUTLINE_MIN_SECTIONS = 4;
export const ANGLE_OUTLINE_MAX_SECTIONS = 7;

export const MAX_ANGLE_OVERLAP = 0.85;
export const MIN_SOURCES_PER_ANGLE = 2;


export const MAX_SECTIONS_PER_REVISION = 2;

export const MAX_REVISION_ROUNDS = 2;

export const MAX_REPLANS_BEFORE_CONFIRM = 2;
export const CHANNEL_LIMITS = {
  linkedin: {
    maxChars: 3_000,
    maxLinesPerParagraph: 3,
    maxEmoji: 5,
  },
  x: {
    maxChars: 280,

    urlWeight: 23,

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


export const ALL_CHANNELS = ["linkedin", "x", "newsletter"] as const;
export type Channel = (typeof ALL_CHANNELS)[number];


export const CHANNEL_DEFAULT_KIND = {
  linkedin: "handoff",
  x: "handoff",
  newsletter: "delivering",
} as const satisfies Record<Channel, "delivering" | "handoff">;


export const CHANNEL_FORMAT_RETRIES = 1;
export const ALT_TEXT_MAX_CHARS = 125;
export const IMAGE_CANDIDATE_COUNT = 6;
export const PUBLISH_MAX_ATTEMPTS = 3;

export const PUBLISH_BATCH_SIZE = 10;

export const PUBLISH_STUCK_MINUTES = 5;

export const HANDOFF_REMINDER_HOURS = 2;

export const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

export const HANDOFF_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const RUNNER_LEASE_SECONDS = 75;

export const MAX_STEP_ATTEMPTS = 3;

export const FETCH_BATCH_SIZE = 4;
export const DEFAULT_BUDGET_CENTS = 150;
export const MAX_SEED_URLS = 10;

export const MIN_IDEA_CHARS = 15;
export const MAX_IDEA_CHARS = 2_000;

// A provider deadline leaves time to checkpoint before the route deadline.
export const PROVIDER_TIMEOUT_MS = 90_000;
export const RUNNER_DRAIN_MS = 180_000;
