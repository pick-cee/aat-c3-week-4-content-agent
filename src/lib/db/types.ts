/**
 * Domain types mirroring supabase/migrations/0001_schema.sql.
 *
 * Hand-written rather than generated, because the generated shape hides the
 * distinctions this system is built on — `empty` vs `fetch_failed`,
 * `published` vs `posted_manually`, `not_evaluated` vs `pass`. Those unions
 * are the specification, so they are spelled out where a reader will see them.
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export type UserRole = "manager" | "reviewer" | "admin";

export type RequestStatus =
  | "draft"
  | "researching"
  | "plan_review"
  | "drafting"
  | "evaluating"
  | "revising"
  | "adapting"
  | "content_review"
  | "scheduled"
  | "publishing"
  | "published"
  | "needs_human"
  | "failed"
  | "budget_exceeded"
  | "cancelled";

/** DESIGN.md §3: terminal states. Nothing advances out of these. */
export const TERMINAL_STATUSES = [
  "published",
  "needs_human",
  "failed",
  "budget_exceeded",
  "cancelled",
] as const satisfies readonly RequestStatus[];

export function isTerminal(status: RequestStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * `empty` (fetched, nothing there) and `fetch_failed` (never fetched) are
 * different values, because a dead fetch and a genuinely empty result
 * producing the same message is useless. DESIGN.md §5.4.
 */
export type FetchStatus =
  | "pending"
  | "ok"
  | "fetch_failed"
  | "blocked"
  | "paywalled"
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "redirected_offsite";

/** `not_evaluated` can never become `pass`. DESIGN.md §5.8. */
export type EvaluationStatus = "pass" | "revise" | "reject" | "not_evaluated";

export type ChannelName = "linkedin" | "x" | "newsletter";

export type ChannelOutputStatus = "draft" | "approved" | "rejected" | "format_failed";

/**
 * `published` means a provider returned an identifier. A handoff channel can
 * never reach it — it reaches `awaiting_manual_post`, and only a person
 * confirming with a URL makes it `posted_manually`. DESIGN.md §2.9.
 */
export type PublishStatus =
  | "queued"
  | "publishing"
  | "published"
  | "awaiting_manual_post"
  | "posted_manually"
  | "failed"
  | "uncertain"
  | "blocked_not_connected"
  | "partially_delivered"
  | "published_dry_run"
  | "cancelled";

/**
 *  is the state for a delivery whose provider never responded. It
 * is NOT : a failed send can be retried safely, and an unknown one
 * cannot — re-sending it is how a recipient gets the same message twice
 * (rule 9b, §15.5).
 */
export type DeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "failed"
  | "uncertain"
  | "skipped_no_optin";

export type ConnectorKind = "delivering" | "handoff";

export type ConnectorStatus =
  | "connected"
  | "not_connected"
  | "expired"
  | "revoked"
  | "error";

export type ArticleOrigin = "initial" | "revision" | "human_edit";
export type SourceOrigin = "seed" | "discovered";
export type ApprovalDecision = "approved" | "rejected" | "revision_requested";
export type ModelCallOutcome = "used" | "discarded" | "failed";
export type LogLevel = "info" | "warn" | "error";

/** Steps the runner can be at. Each non-terminal state names the step. §3.1. */
export type PipelineStep =
  | "discover"
  | "fetch"
  | "chunk_embed"
  | "score"
  | "plan"
  | "draft"
  | "evaluate"
  | "revise"
  | "adapt"
  | "image";

// ─── Tables ─────────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  is_demo: boolean;
  created_at: string;
}

export interface BrandVoice {
  id: string;
  name: string;
  description: string | null;
  audience_default: string | null;
  tone_rules: string[];
  banned_phrases: string[];
  cta_default: string | null;
  reading_level: string | null;
  emoji_allowance: number;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
}

export interface ContentRequest {
  id: string;
  created_by: string;
  slug: string | null;
  idea: string;
  target_audience: string;
  primary_keyword: string | null;
  seed_urls: string[];
  channels: ChannelName[];
  brand_voice_id: string | null;
  status: RequestStatus;
  current_step: PipelineStep | null;
  step_attempts: number;
  runner_lease_until: string | null;
  runner_lease_id: string | null;
  /** Which step owns the failure, so a retry resumes there (§17). */
  failed_step: PipelineStep | null;
  failure_reason: string | null;
  failure_detail: Record<string, unknown> | null;
  /** e.g. 'no_sources_found' — distinct from a failure. DESIGN.md §7.1. */
  research_outcome: string | null;
  research_queries: unknown | null;
  budget_cents: number;
  estimated_cost_cents: number | null;
  actual_cost_cents: number;
  /** False → the UI renders "at least $X". DESIGN.md §5.3. */
  cost_complete: boolean;
  revision_rounds: number;
  replans: number;
  submit_token: string | null;
  publish_target: string | null;
  hold_in_queue: boolean;
  created_at: string;
  updated_at: string;
}

export interface Source {
  id: string;
  request_id: string;
  url: string;
  url_canonical: string;
  origin: SourceOrigin;
  discovered_via_query: string | null;
  title: string | null;
  site_name: string | null;
  author: string | null;
  published_at: string | null;
  fetch_status: FetchStatus;
  fetch_error: string | null;
  http_status: number | null;
  content_hash: string | null;
  markdown_chars: number | null;
  markdown: string | null;
  from_cache: boolean;
  relevance_score: number | null;
  embed_failed: boolean;
  embed_error: string | null;
  included: boolean;
  excluded_by: string | null;
  excluded_reason: string | null;
  credits_used: number | null;
  fetched_at: string | null;
  created_at: string;
}

export interface Excerpt {
  id: string;
  source_id: string;
  request_id: string;
  ordinal: number;
  text: string;
  heading_path: string | null;
  char_start: number | null;
  char_end: number | null;
  token_estimate: number | null;
  /**
   * pgvector. Written as the literal string "[0.1,0.2,…]" (see
   * `toVectorLiteral`) and read back as that same string through PostgREST,
   * so the wire type is a string even though the value is a vector. Use
   * `parseVector` to get numbers out of it.
   */
  embedding: string | null;
  created_at: string;
}

/** One H2 section of a proposed angle. */
export interface OutlineSection {
  heading: string;
  intent: string;
}

export interface Angle {
  id: string;
  request_id: string;
  label: string;
  headline: string;
  outline: OutlineSection[];
  primary_keyword: string;
  secondary_keywords: string[];
  excerpt_ids: string[];
  rationale: string | null;
  chosen: boolean;
  invalidated: boolean;
  invalidated_reason: string | null;
  model_used: string | null;
  created_at: string;
}

/**
 * sentence index → the excerpts it cites. Built mechanically from the markers
 * in the body, never asked for. DESIGN.md §8.3.
 */
export interface ClaimMapEntry {
  sentenceIndex: number;
  sentence: string;
  /** Short per-request labels, e.g. ["E12", "E3"]. */
  labels: string[];
  excerptIds: string[];
  sourceIds: string[];
  /** Max cosine similarity to any cited excerpt. DESIGN.md §8.4. */
  groundingScore: number | null;
  verdict: "grounded" | "weak" | "unsupported" | "unscored";
}

export interface LinkTarget {
  /** The anchor text the model marked. */
  anchor: string;
  /** Which excerpt the link should point at — the model names intent, not URL. */
  label: string;
  excerptId: string | null;
  sourceId: string | null;
  /** Substituted server-side from the source's real URL. §10. */
  url: string | null;
}

export interface HeadingNode {
  level: 1 | 2 | 3;
  text: string;
}

export interface ArticleVersion {
  id: string;
  request_id: string;
  version: number;
  angle_id: string | null;
  title: string;
  meta_description: string | null;
  body_md: string;
  primary_keyword: string | null;
  secondary_keywords: string[];
  word_count: number | null;
  headings: HeadingNode[] | null;
  claim_map: ClaimMapEntry[] | null;
  link_targets: LinkTarget[] | null;
  excerpt_ids_used: string[];
  origin: ArticleOrigin;
  parent_version_id: string | null;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

/**
 * A criterion the judge could not assess is `null` with a reason, never a
 * score. A null propagates: overall cannot be `pass` with one in it. §11.1.
 */
export interface JudgedCriterion {
  score: 1 | 2 | 3 | 4 | 5 | null;
  reason: string;
}

export interface ComputedChecks {
  sourceGrounding: {
    markedSentences: number;
    factualSentences: number;
    markedRatio: number;
    weakCount: number;
    unsupportedCount: number;
    passed: boolean;
  };
  factualConsistency: {
    unsupportedCandidates: number;
    numberDisagreements: number;
    passed: boolean;
  };
  seoFit: {
    keywordInTitle: boolean;
    keywordInFirst100: boolean;
    exactlyOneH1: boolean;
    hasH2s: boolean;
    linkCount: number;
    linksResolve: boolean;
    longParagraphs: number;
    passed: boolean;
  };
  completeness: {
    outlineSectionsPresent: number;
    outlineSectionsExpected: number;
    channelsProduced: number;
    channelsRequested: number;
    passed: boolean;
  };
  bannedPhrases: string[];
}

export interface Evaluation {
  id: string;
  article_version_id: string;
  request_id: string;
  status: EvaluationStatus;
  computed: ComputedChecks | null;
  judged: Record<string, JudgedCriterion> | null;
  unsupported_claims: ClaimMapEntry[] | null;
  weak_citations: ClaimMapEntry[] | null;
  sections_to_revise: { heading: string; problem: string }[] | null;
  recommended_changes: string | null;
  overall_note: string | null;
  judge_verdict: string | null;
  /** The judge's verdict does not decide; a computed failure overrules it. §11.2. */
  judge_overruled: boolean;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
  created_at: string;
}

export interface FormatCheckResult {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

export interface ChannelOutput {
  id: string;
  request_id: string;
  article_version_id: string;
  channel: ChannelName;
  version: number;
  subject: string | null;
  body: string;
  hashtags: string[];
  cta: string | null;
  includes_link: boolean;
  link_url: string | null;
  char_count: number | null;
  claim_map: ClaimMapEntry[] | null;
  format_check: FormatCheckResult | null;
  status: ChannelOutputStatus;
  model_used: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export interface ImageCandidate {
  id: string;
  request_id: string;
  provider: string;
  provider_asset_id: string | null;
  source_page_url: string | null;
  download_url: string;
  storage_path: string | null;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  /** NOT NULL in the schema: a row with no licence is never attached. §5.10. */
  licence: string;
  licence_url: string | null;
  attribution_text: string | null;
  query_used: string | null;
  chosen: boolean;
  created_at: string;
}

export interface Approval {
  id: string;
  request_id: string;
  subject_type: "article" | "channel_output";
  subject_id: string;
  actor_id: string;
  decision: ApprovalDecision;
  note: string | null;
  created_at: string;
}

export interface PublishQueueItem {
  id: string;
  request_id: string;
  channel_output_id: string;
  channel: ChannelName;
  kind: ConnectorKind;
  scheduled_for: string;
  status: PublishStatus;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  idempotency_key: string;
  approved_by: string;
  approved_at: string;
  handoff_sent_at: string | null;
  handoff_reminded_at: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  estimated_cost_cents: number | null;
  actual_cost_cents: number | null;
  reserved_at: string | null;
  published_at: string | null;
  created_at: string;
}

export interface PublishDelivery {
  id: string;
  queue_id: string;
  recipient_id: string;
  channel: ChannelName;
  status: DeliveryStatus;
  provider_message_id: string | null;
  error_code: string | null;
  error_text: string | null;
  cost_cents: number;
  is_dry_run: boolean;
  sent_at: string | null;
  updated_at: string;
  created_at: string;
}

/** Never selected with its token columns into anything client-facing. §19.2. */
export interface ConnectorStatusRow {
  id: string;
  channel: ChannelName;
  kind: ConnectorKind;
  status: ConnectorStatus;
  account_label: string | null;
  expires_at: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface Recipient {
  id: string;
  channel: ChannelName;
  handle: string;
  display_name: string | null;
  opted_in_at: string | null;
  opt_in_source: string | null;
  opt_out_at: string | null;
  created_at: string;
}

export interface ModelCall {
  id: string;
  request_id: string | null;
  step: string;
  purpose: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  web_searches: number;
  cost_cents: number;
  outcome: ModelCallOutcome;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
}

export interface ActivityLogEntry {
  id: string;
  request_id: string | null;
  queue_id: string | null;
  step: string | null;
  level: LogLevel;
  message: string;
  detail: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
}

/**
 * Database shape for the Supabase client's generics.
 *
 * Hand-written to match what supabase-js expects: every table carries
 * Row/Insert/Update/Relationships, and the RPC functions are typed by their
 * argument and return shapes so a renamed parameter is a compile error rather
 * than a runtime "function does not exist".
 */

/**
 * Inserts and updates allow partials — the database fills defaults for most
 * columns. `Row` is widened with an index signature because postgrest-js
 * constrains each table to `Record<string, unknown>`, and an interface without
 * one does not satisfy that constraint (an interface has no implicit index
 * signature, unlike a type alias).
 */
type Table<T> = {
  Row: T & Record<string, unknown>;
  Insert: Partial<T> & Record<string, unknown>;
  Update: Partial<T> & Record<string, unknown>;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: {
      ca_profiles: Table<Profile>;
      ca_brand_voices: Table<BrandVoice>;
      ca_content_requests: Table<ContentRequest>;
      ca_sources: Table<Source>;
      ca_excerpts: Table<Excerpt>;
      ca_angles: Table<Angle>;
      ca_article_versions: Table<ArticleVersion>;
      ca_evaluations: Table<Evaluation>;
      ca_channel_outputs: Table<ChannelOutput>;
      ca_images: Table<ImageCandidate>;
      ca_approvals: Table<Approval>;
      ca_publish_queue: Table<PublishQueueItem>;
      ca_publish_deliveries: Table<PublishDelivery>;
      ca_connectors: Table<ConnectorStatusRow & Record<string, unknown>>;
      ca_recipients: Table<Recipient>;
      ca_model_calls: Table<ModelCall>;
      ca_activity_log: Table<ActivityLogEntry>;
      ca_usage_counters: Table<Record<string, unknown>>;
    };
    Views: {
      ca_connector_view: {
        Row: ConnectorStatusRow & Record<string, unknown>;
        Relationships: [];
      };
    };
    Functions: {
      claim_request_lease: {
        Args: { p_request_id: string; p_lease_id: string; p_lease_secs?: number };
        Returns: ContentRequest;
      };
      claim_next_runnable_request: {
        Args: { p_lease_id: string; p_lease_secs?: number };
        Returns: ContentRequest;
      };
      release_request_lease: {
        Args: { p_request_id: string; p_lease_id: string };
        Returns: void;
      };
      claim_due_publish_item: {
        Args: Record<string, unknown>;
        Returns: PublishQueueItem;
      };
      sweep_stuck_publishing: {
        Args: { p_minutes?: number };
        Returns: PublishQueueItem[];
      };
      sweep_stuck_deliveries: {
        Args: { p_minutes?: number };
        Returns: PublishDelivery[];
      };
      bump_counter: {
        Args: {
          p_scope: string;
          p_scope_key: string;
          p_window: string;
          p_metric: string;
          p_cents?: number;
        };
        Returns: number;
      };
      read_counter: {
        Args: { p_scope: string; p_scope_key: string; p_window: string; p_metric: string };
        Returns: number;
      };
      add_request_cost: {
        Args: { p_request_id: string; p_cents: number; p_complete?: boolean };
        Returns: ContentRequest;
      };
      match_excerpts: {
        Args: {
          p_request_id: string;
          p_embedding: string;
          p_limit?: number;
          p_included_only?: boolean;
        };
        Returns: {
          id: string;
          source_id: string;
          text: string;
          heading_path: string | null;
          ordinal: number;
          similarity: number;
        }[];
      };
      score_source_relevance: {
        Args: { p_request_id: string; p_embedding: string };
        Returns: void;
      };
      assert_output_approved: {
        Args: { p_channel_output_id: string };
        Returns: boolean;
      };
      dashboard_counts: {
        Args: Record<string, unknown>;
        Returns: {
          needs_you: number;
          scheduled_today: number;
          failed_blocked: number;
          spent_month_cents: number;
          spend_complete: boolean | null;
        }[];
      };
    };
  };
}
