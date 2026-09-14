-- ═══════════════════════════════════════════════════════════════════════════
-- AI Content Research and Publishing Agent — schema
-- DESIGN.md §5. Postgres on Supabase, pgvector enabled.
--
-- The constraints in this file are not decoration. Several of the guarantees
-- DESIGN.md makes are enforced here and nowhere else, deliberately, because
-- application logic gets refactored and a check constraint does not:
--
--   · publish_queue.approved_by NOT NULL      → publishing before approval is
--                                               impossible (§14.3, point 3)
--   · unique (request_id, url_canonical)      → idempotent ingestion (§5.4)
--   · unique publish_queue.idempotency_key    → one live intent per output
--   · unique (queue_id, recipient_id)         → nobody gets the broadcast twice
--   · content_requests.submit_token unique    → a double-click makes one request
--   · handoff channels cannot be 'published'  → the system never shows a
--                                               success it did not receive (§9)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── The schema ────────────────────────────────────────────────────────────
-- Everything this build owns lives in `content_agent`, not `public`.
--
-- The Supabase project already hosts another application whose `profiles`,
-- `approvals` and `activity_log` tables have different shapes. Sharing
-- `public` would mean either renaming half of this build's tables or dropping
-- someone else's data, and `create table if not exists` against a colliding
-- name fails in the worst way: it silently does nothing, and the failure
-- surfaces later as a missing column on a table you thought you had created.
--
-- A dedicated schema is the boundary Postgres already provides.

create schema if not exists content_agent;

-- Extensions stay in `public`/`extensions` where Supabase puts them, and are
-- reachable from here via the search_path set below.
create extension if not exists "vector";
create extension if not exists "pgcrypto";

-- Applies for the rest of this migration, so every unqualified `create table`
-- lands in content_agent rather than public.
set local search_path = content_agent, public, extensions;

-- ─── Enums ─────────────────────────────────────────────────────────────────
-- Enums rather than text+check: an invalid status becomes a write error at the
-- boundary instead of a value nobody notices until it renders.

do $$ begin
  create type user_role as enum ('manager', 'reviewer', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type request_status as enum (
    'draft',
    'researching',
    'plan_review',      -- gate one: confirm sources, pick angle
    'drafting',
    'evaluating',
    'revising',
    'adapting',
    'content_review',   -- gate two: approve per channel
    'scheduled',
    'publishing',
    'published',
    -- Terminal, and each names why. A request that dies halfway is never
    -- ambiguous about where it died (§3).
    'needs_human',
    'failed',
    'budget_exceeded',
    'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type fetch_status as enum (
    'pending',
    'ok',
    'fetch_failed',       -- never fetched
    'blocked',
    'paywalled',
    'empty',              -- fetched, nothing there — NOT the same as failed (§5.4)
    'too_large',
    'unsupported_type',
    'redirected_offsite'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type evaluation_status as enum (
    'pass',
    'revise',
    'reject',
    -- An evaluation that could not run must never be indistinguishable from
    -- one that passed, and can never become 'pass' (§5.8).
    'not_evaluated'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type channel_name as enum ('linkedin', 'x', 'newsletter');
exception when duplicate_object then null; end $$;

do $$ begin
  create type channel_output_status as enum (
    'draft', 'approved', 'rejected', 'format_failed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type publish_status as enum (
    'queued',
    'publishing',
    'published',              -- a provider returned an identifier (§2.9)
    'awaiting_manual_post',   -- handoff dispatched, nobody has confirmed
    'posted_manually',        -- a person confirmed with a URL — real, and
                              -- visibly not something this system did
    'failed',
    'uncertain',              -- outcome unknown. Never auto-retried (§15.5)
    'blocked_not_connected',
    'partially_delivered',    -- fan-out: real counts, never a bare status word
    'published_dry_run',      -- DEMO_MODE. A distinct value (§19.6)
    'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type delivery_status as enum (
    'pending', 'sent', 'delivered', 'failed', 'skipped_no_optin'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type connector_kind as enum ('delivering', 'handoff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type connector_status as enum (
    'connected', 'not_connected', 'expired', 'revoked', 'error'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type article_origin as enum ('initial', 'revision', 'human_edit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type source_origin as enum ('seed', 'discovered');
exception when duplicate_object then null; end $$;

do $$ begin
  create type approval_decision as enum (
    'approved', 'rejected', 'revision_requested'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type model_call_outcome as enum ('used', 'discarded', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type log_level as enum ('info', 'warn', 'error');
exception when duplicate_object then null; end $$;

-- ─── 5.1 profiles ──────────────────────────────────────────────────────────

create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        user_role not null default 'manager',
  is_demo     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ─── 5.2 brand_voices ──────────────────────────────────────────────────────
-- Without a stored voice, "tone matches the brand" is unfalsifiable, so the
-- rubric's Tone criterion is judged against this row (§5.2).

create table if not exists brand_voices (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  description      text,
  audience_default text,
  tone_rules       text[] not null default '{}',
  banned_phrases   text[] not null default '{}',
  cta_default      text,
  reading_level    text,
  emoji_allowance  int not null default 3,
  is_default       boolean not null default false,
  created_by       uuid references profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

-- At most one default voice, enforced rather than assumed.
create unique index if not exists brand_voices_one_default
  on brand_voices ((is_default)) where is_default;

-- ─── 5.3 content_requests ──────────────────────────────────────────────────

create table if not exists content_requests (
  id                    uuid primary key default gen_random_uuid(),
  created_by            uuid not null references profiles(id) on delete cascade,
  slug                  text unique,
  idea                  text not null,
  target_audience       text not null,
  primary_keyword       text,
  seed_urls             text[] not null default '{}',
  channels              channel_name[] not null default '{linkedin,x,newsletter}',
  brand_voice_id        uuid references brand_voices(id) on delete set null,

  status                request_status not null default 'draft',
  current_step          text,
  step_attempts         int not null default 0,

  -- Two runners must never process the same request. The lease is claimed with
  -- a conditional UPDATE; no row returned means someone else holds it (§3.1).
  runner_lease_until    timestamptz,
  runner_lease_id       text,

  failed_step           text,
  failure_reason        text,
  failure_detail        jsonb,

  -- Research outcome is distinct from failure: a topic that returns nothing
  -- usable ends at needs_human, not in an ungrounded article (§7.1).
  research_outcome      text,
  research_queries      jsonb,

  budget_cents          int not null default 150,
  estimated_cost_cents  int,
  actual_cost_cents     int not null default 0,
  -- False if any model_calls insert failed. A total that might be missing a
  -- call is displayed as "at least $X", never a smaller confident number (§5.3).
  cost_complete         boolean not null default true,

  revision_rounds       int not null default 0,
  replans               int not null default 0,

  -- A double-click creates one request. The uniqueness is a database
  -- constraint, not a disabled button (§5.3).
  submit_token          text unique,

  publish_target        timestamptz,
  hold_in_queue         boolean not null default false,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint budget_positive check (budget_cents > 0),
  constraint idea_not_empty check (char_length(trim(idea)) >= 15)
);

create index if not exists content_requests_status_idx on content_requests (status);
create index if not exists content_requests_created_by_idx on content_requests (created_by);
-- The runner scans for claimable work by status + free lease.
create index if not exists content_requests_lease_idx
  on content_requests (status, runner_lease_until);

-- ─── 5.4 sources ───────────────────────────────────────────────────────────

create table if not exists sources (
  id                   uuid primary key default gen_random_uuid(),
  request_id           uuid not null references content_requests(id) on delete cascade,
  url                  text not null,
  url_canonical        text not null,
  origin               source_origin not null,
  discovered_via_query text,
  title                text,
  site_name            text,
  author               text,
  published_at         timestamptz,

  fetch_status         fetch_status not null default 'pending',
  fetch_error          text,
  http_status          int,
  content_hash         text,
  markdown_chars       int,
  markdown             text,
  -- Firecrawl maxAge reuse. A cached scrape is a paid no-op avoided (§18.4).
  from_cache           boolean not null default false,

  relevance_score      numeric,
  -- Embedding failure marks the source and excludes it from vector selection,
  -- but it stays available for manual inclusion with a visible note. It is
  -- never silently dropped (§7.4).
  embed_failed         boolean not null default false,
  embed_error          text,

  included             boolean not null default true,
  excluded_by          uuid references profiles(id) on delete set null,
  excluded_reason      text,

  credits_used         int,
  fetched_at           timestamptz,
  created_at           timestamptz not null default now(),

  -- Two links to the same article do not become two sources (§5.4).
  unique (request_id, url_canonical)
);

create index if not exists sources_request_idx on sources (request_id);
create index if not exists sources_status_idx on sources (request_id, fetch_status);
-- Lets a later request skip re-embedding a page whose content is unchanged.
create index if not exists sources_content_hash_idx on sources (content_hash);

-- ─── 5.5 excerpts ──────────────────────────────────────────────────────────
-- Chunking is deterministic and involves no model. A model call to do a
-- splitter's job is money spent on nothing (§5.5).

create table if not exists excerpts (
  id             uuid primary key default gen_random_uuid(),
  source_id      uuid not null references sources(id) on delete cascade,
  request_id     uuid not null references content_requests(id) on delete cascade,
  ordinal        int not null,
  text           text not null,
  heading_path   text,
  char_start     int,
  char_end       int,
  token_estimate int,
  embedding      vector(512),
  created_at     timestamptz not null default now(),

  unique (source_id, ordinal)
);

create index if not exists excerpts_request_idx on excerpts (request_id);
create index if not exists excerpts_embedding_idx
  on excerpts using hnsw (embedding vector_cosine_ops);

-- ─── 5.6 angles ────────────────────────────────────────────────────────────

create table if not exists angles (
  id                  uuid primary key default gen_random_uuid(),
  request_id          uuid not null references content_requests(id) on delete cascade,
  label               text not null,
  headline            text not null,
  outline             jsonb not null,
  primary_keyword     text not null,
  secondary_keywords  text[] not null default '{}',
  excerpt_ids         uuid[] not null default '{}',
  rationale           text,
  chosen              boolean not null default false,
  -- Excluding a source after angles exist invalidates any angle that used it.
  -- The card greys out with the reason rather than silently continuing on a
  -- foundation that was just removed (§14.1).
  invalidated         boolean not null default false,
  invalidated_reason  text,
  model_used          text,
  created_at          timestamptz not null default now()
);

create index if not exists angles_request_idx on angles (request_id);
create unique index if not exists angles_one_chosen
  on angles (request_id) where chosen;

-- ─── 5.7 article_versions ──────────────────────────────────────────────────
-- Versions are never overwritten. The review history the brief asks for is
-- this table plus `evaluations` (§5.7).

create table if not exists article_versions (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references content_requests(id) on delete cascade,
  version            int not null,
  angle_id           uuid references angles(id) on delete set null,
  title              text not null,
  meta_description   text,
  body_md            text not null,
  primary_keyword    text,
  secondary_keywords text[] not null default '{}',
  word_count         int,
  headings           jsonb,
  -- sentence index → excerpt ids → source ids. Built mechanically (§8.3).
  claim_map          jsonb,
  link_targets       jsonb,
  -- Every excerpt passed to the model, so "which sources informed this output"
  -- has a stored answer rather than a reconstructed one (§8.2).
  excerpt_ids_used   uuid[] not null default '{}',
  origin             article_origin not null default 'initial',
  parent_version_id  uuid references article_versions(id) on delete set null,
  model_used         text,
  input_tokens       int,
  output_tokens      int,
  created_at         timestamptz not null default now(),

  unique (request_id, version)
);

create index if not exists article_versions_request_idx
  on article_versions (request_id, version desc);

-- ─── 5.8 evaluations ───────────────────────────────────────────────────────

create table if not exists evaluations (
  id                  uuid primary key default gen_random_uuid(),
  article_version_id  uuid not null references article_versions(id) on delete cascade,
  request_id          uuid not null references content_requests(id) on delete cascade,
  status              evaluation_status not null,
  -- Computed first, because those are facts. Judged second (§14.2).
  computed            jsonb,
  judged              jsonb,
  unsupported_claims  jsonb,
  weak_citations      jsonb,
  sections_to_revise  jsonb,
  recommended_changes text,
  overall_note        text,
  -- The judge's own verdict is stored and displayed, but it does not decide.
  -- A model returning `pass` while a computed check fails is overruled, and
  -- the disagreement is logged (§11.2).
  judge_verdict       text,
  judge_overruled     boolean not null default false,
  model_used          text,
  input_tokens        int,
  output_tokens       int,
  error               text,
  created_at          timestamptz not null default now()
);

create index if not exists evaluations_request_idx on evaluations (request_id);
create index if not exists evaluations_version_idx on evaluations (article_version_id);

-- ─── 5.9 channel_outputs ───────────────────────────────────────────────────

create table if not exists channel_outputs (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references content_requests(id) on delete cascade,
  article_version_id uuid not null references article_versions(id) on delete cascade,
  channel            channel_name not null,
  version            int not null default 1,
  subject            text,             -- newsletter only
  body               text not null,
  hashtags           text[] not null default '{}',
  cta                text,
  includes_link      boolean not null default false,
  link_url           text,
  char_count         int,
  claim_map          jsonb,
  format_check       jsonb,
  status             channel_output_status not null default 'draft',
  model_used         text,
  input_tokens       int,
  output_tokens      int,
  created_at         timestamptz not null default now(),

  unique (request_id, channel, version)
);

create index if not exists channel_outputs_request_idx on channel_outputs (request_id);

-- ─── 5.10 images ───────────────────────────────────────────────────────────
-- A row with no licence is never attached to content (§5.10), so the column
-- is NOT NULL rather than checked in application code.

create table if not exists images (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references content_requests(id) on delete cascade,
  provider          text not null,
  provider_asset_id text,
  source_page_url   text,
  download_url      text not null,
  storage_path      text,
  width             int,
  height            int,
  alt_text          text,
  licence           text not null,
  licence_url       text,
  attribution_text  text,
  query_used        text,
  chosen            boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists images_request_idx on images (request_id);
create unique index if not exists images_one_chosen
  on images (request_id) where chosen;

-- ─── 5.11 approvals ────────────────────────────────────────────────────────

create table if not exists approvals (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references content_requests(id) on delete cascade,
  subject_type text not null check (subject_type in ('article', 'channel_output')),
  subject_id   uuid not null,
  actor_id     uuid not null references profiles(id) on delete restrict,
  decision     approval_decision not null,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists approvals_request_idx on approvals (request_id);
create index if not exists approvals_subject_idx on approvals (subject_type, subject_id);

-- ─── 5.12 publish_queue ────────────────────────────────────────────────────

create table if not exists publish_queue (
  id                   uuid primary key default gen_random_uuid(),
  request_id           uuid not null references content_requests(id) on delete cascade,
  channel_output_id    uuid not null references channel_outputs(id) on delete cascade,
  channel              channel_name not null,
  kind                 connector_kind not null,
  scheduled_for        timestamptz not null,
  status               publish_status not null default 'queued',
  attempt              int not null default 0,
  max_attempts         int not null default 3,
  last_error           text,
  platform_post_id     text,
  platform_url         text,
  idempotency_key      text not null,

  -- §14.3, enforcement point 3: a queue row cannot exist without an approval
  -- to point at. This is the one that holds even if the other two are edited
  -- away, which is exactly why it is a NOT NULL and not a code path.
  approved_by          uuid not null references profiles(id) on delete restrict,
  approved_at          timestamptz not null,

  -- Handoff bookkeeping (§15.4).
  handoff_sent_at      timestamptz,
  handoff_reminded_at  timestamptz,
  confirmed_by         uuid references profiles(id) on delete set null,
  confirmed_at         timestamptz,

  estimated_cost_cents int,
  actual_cost_cents    int,
  reserved_at          timestamptz,
  published_at         timestamptz,
  created_at           timestamptz not null default now(),

  -- A handoff channel can never reach 'published' on its own. The system
  -- never displays a success it did not receive (§2.9, §5.12). Enforced here
  -- because it is the single most consequential honesty guarantee in the build.
  constraint handoff_never_published check (
    not (kind = 'handoff' and status in ('published', 'published_dry_run'))
  ),
  -- Symmetrically, a channel the system sends itself cannot claim a human
  -- posted it.
  constraint delivering_never_manual check (
    not (kind = 'delivering' and status in ('awaiting_manual_post', 'posted_manually'))
  ),
  -- 'published' means a provider returned an identifier, stored on the row (§9).
  constraint published_has_identifier check (
    status <> 'published' or platform_post_id is not null
  ),
  -- posted_manually requires the URL a person actually confirmed (§15.4).
  constraint manual_post_has_url check (
    status <> 'posted_manually' or platform_url is not null
  )
);

-- One live intent per approved output, while still allowing a cancelled item
-- to be re-queued (§5.12).
create unique index if not exists publish_queue_one_live
  on publish_queue (channel_output_id) where status <> 'cancelled';
create unique index if not exists publish_queue_idempotency
  on publish_queue (idempotency_key) where status <> 'cancelled';
-- The release worker's claim query: status + due time, oldest first.
create index if not exists publish_queue_due_idx
  on publish_queue (status, scheduled_for);
create index if not exists publish_queue_request_idx on publish_queue (request_id);

-- ─── 5.12a publish_deliveries ──────────────────────────────────────────────
-- The unit of work for a fan-out channel is a recipient, not a queue row.
-- This table IS the idempotency record: a retry after a partial failure
-- re-sends to the three that failed, never to the thirty-seven that
-- succeeded. Sending the same newsletter to a subscriber twice is the most
-- visible failure this system could produce (§5.12a, §15.3).

create table if not exists publish_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  queue_id            uuid not null references publish_queue(id) on delete cascade,
  recipient_id        uuid not null,
  channel             channel_name not null,
  status              delivery_status not null default 'pending',
  provider_message_id text,
  error_code          text,
  error_text          text,
  cost_cents          int not null default 0,
  is_dry_run          boolean not null default false,
  sent_at             timestamptz,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  unique (queue_id, recipient_id)
);

create index if not exists publish_deliveries_queue_idx
  on publish_deliveries (queue_id, status);
-- Reconciliation looks a delivery up by the provider's message id (§15.5).
create index if not exists publish_deliveries_provider_msg_idx
  on publish_deliveries (provider_message_id);

-- ─── 5.13 connectors ───────────────────────────────────────────────────────
-- `kind` is what the publish worker branches on, never a hardcoded channel
-- name. If LinkedIn access is ever obtained, that channel becomes
-- 'delivering' by changing one row, and no publishing code changes (§5.13).

create table if not exists connectors (
  id                uuid primary key default gen_random_uuid(),
  channel           channel_name not null unique,
  kind              connector_kind not null,
  status            connector_status not null default 'not_connected',
  account_label     text,
  account_urn       text,
  scopes            text[] not null default '{}',
  -- AES-256-GCM at rest, decrypted only inside the publish path, never
  -- selected into anything that reaches a client component (§5.13, §19.2).
  access_token_enc  bytea,
  refresh_token_enc bytea,
  expires_at        timestamptz,
  connected_by      uuid references profiles(id) on delete set null,
  last_verified_at  timestamptz,
  last_error        text,
  -- Who receives the copy-ready packet, for handoff channels (§15.4).
  handoff_email     text,
  handoff_phone     text,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- ─── 5.13a recipients ──────────────────────────────────────────────────────
-- An automation that can message forty people is an automation that can annoy
-- forty people, and the consent record is what separates the two (§19.5b).

create table if not exists recipients (
  id            uuid primary key default gen_random_uuid(),
  channel       channel_name not null,
  handle        text not null,   -- email address
  display_name  text,
  -- NULL here means never sent to. Checked in the send path, not only at
  -- import (§5.13a).
  opted_in_at   timestamptz,
  opt_in_source text,
  -- Opt-out is immediate and permanent.
  opt_out_at    timestamptz,
  created_at    timestamptz not null default now(),

  unique (channel, handle),
  -- Newsletter is the only channel the system delivers to itself; LinkedIn
  -- and X are handoff and have no recipient list (§15.1).
  constraint recipient_channel_is_deliverable
    check (channel = 'newsletter')
);

create index if not exists recipients_sendable_idx
  on recipients (channel) where opted_in_at is not null and opt_out_at is null;

-- ─── 5.14 model_calls ──────────────────────────────────────────────────────
-- Every call, including discarded ones. A rejected draft cost real money.
-- article_versions keeps what survived; this keeps what was spent (§5.14).

create table if not exists model_calls (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid references content_requests(id) on delete cascade,
  step              text not null,
  purpose           text,
  model             text not null,
  input_tokens      int not null default 0,
  output_tokens     int not null default 0,
  cache_read_tokens int not null default 0,
  web_searches      int not null default 0,
  cost_cents        numeric not null default 0,
  outcome           model_call_outcome not null,
  error             text,
  latency_ms        int,
  created_at        timestamptz not null default now()
);

create index if not exists model_calls_request_idx on model_calls (request_id);
create index if not exists model_calls_created_idx on model_calls (created_at);

-- ─── 5.15 activity_log ─────────────────────────────────────────────────────
-- Every state transition writes a row. Every failure writes one with a
-- plain-language message a non-engineer can read and a detail an engineer can
-- debug from (§5.15). `detail` passes through a redactor before insert (§19.8).

create table if not exists activity_log (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid references content_requests(id) on delete cascade,
  queue_id   uuid references publish_queue(id) on delete cascade,
  step       text,
  level      log_level not null default 'info',
  message    text not null,
  detail     jsonb,
  actor_id   uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_request_idx
  on activity_log (request_id, created_at desc);
create index if not exists activity_log_level_idx
  on activity_log (level, created_at desc);

-- ─── 5.16 usage_counters ───────────────────────────────────────────────────
-- Incremented with `insert … on conflict do update set count = count + 1`, so
-- two concurrent requests cannot both read 9 and write 10 (§5.16).

create table if not exists usage_counters (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null check (scope in ('global', 'profile', 'ip')),
  scope_key    text not null,
  window_start timestamptz not null,
  -- `window` alone is a reserved word in Postgres (the WINDOW clause), and
  -- using it unquoted is a syntax error rather than a helpful complaint.
  window_size  text not null check (window_size in ('minute', 'hour', 'day', 'month')),
  metric       text not null,
  count        int not null default 0,
  cents        numeric not null default 0,

  unique (scope, scope_key, window_size, window_start, metric)
);

-- ─── Triggers ──────────────────────────────────────────────────────────────

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists content_requests_touch on content_requests;
create trigger content_requests_touch before update on content_requests
  for each row execute function touch_updated_at();

drop trigger if exists publish_deliveries_touch on publish_deliveries;
create trigger publish_deliveries_touch before update on publish_deliveries
  for each row execute function touch_updated_at();

drop trigger if exists connectors_touch on connectors;
create trigger connectors_touch before update on connectors
  for each row execute function touch_updated_at();
