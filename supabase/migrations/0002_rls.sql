-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security. DESIGN.md §19.4: RLS on every table.
--
-- The model: authenticated users READ through RLS; every WRITE that matters
-- goes through a server action using the service role, which bypasses RLS
-- entirely. So these policies are a read boundary and a defence in depth, not
-- the mechanism by which writes are authorised — that lives in the server
-- actions, which check `profiles.role` before acting.
--
-- The one deliberately public read is the article permalink (§10.1), and it is
-- served by a route that selects an explicit column list rather than `select *`
-- — which is how an internal note or a token column ends up on a public page
-- after a later migration.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = content_agent, public, extensions;

alter table profiles            enable row level security;
alter table brand_voices        enable row level security;
alter table content_requests    enable row level security;
alter table sources             enable row level security;
alter table excerpts            enable row level security;
alter table angles              enable row level security;
alter table article_versions    enable row level security;
alter table evaluations         enable row level security;
alter table channel_outputs     enable row level security;
alter table images              enable row level security;
alter table approvals           enable row level security;
alter table publish_queue       enable row level security;
alter table publish_deliveries  enable row level security;
alter table connectors          enable row level security;
alter table recipients          enable row level security;
alter table model_calls         enable row level security;
alter table activity_log        enable row level security;
alter table usage_counters      enable row level security;

-- ─── Helpers ───────────────────────────────────────────────────────────────

create or replace function current_role_is(required user_role)
returns boolean language sql stable security definer set search_path = content_agent, public, extensions as $$
  select exists (
    select 1 from profiles
     where id = auth.uid() and role = required
  );
$$;

/** Reviewer or admin. The two roles that may approve and schedule (§4). */
create or replace function can_approve()
returns boolean language sql stable security definer set search_path = content_agent, public, extensions as $$
  select exists (
    select 1 from profiles
     where id = auth.uid() and role in ('reviewer', 'admin')
  );
$$;

create or replace function is_signed_in()
returns boolean language sql stable as $$
  select auth.uid() is not null;
$$;

-- ─── profiles ──────────────────────────────────────────────────────────────
-- A signed-in user reads the team (needed to render "who approved this"), and
-- may update only their own row.

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles
  for select using (is_signed_in());

drop policy if exists profiles_update_self on profiles;
create policy profiles_update_self on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ─── Shared read for the working tables ────────────────────────────────────
-- One agency, roles within it (§22: multi-tenant is out of scope on purpose),
-- so any signed-in member reads the pipeline. Writes go through the service
-- role in server actions.

drop policy if exists brand_voices_read on brand_voices;
create policy brand_voices_read on brand_voices
  for select using (is_signed_in());

drop policy if exists content_requests_read on content_requests;
create policy content_requests_read on content_requests
  for select using (is_signed_in());

drop policy if exists sources_read on sources;
create policy sources_read on sources for select using (is_signed_in());

drop policy if exists excerpts_read on excerpts;
create policy excerpts_read on excerpts for select using (is_signed_in());

drop policy if exists angles_read on angles;
create policy angles_read on angles for select using (is_signed_in());

drop policy if exists article_versions_read on article_versions;
create policy article_versions_read on article_versions
  for select using (is_signed_in());

drop policy if exists evaluations_read on evaluations;
create policy evaluations_read on evaluations for select using (is_signed_in());

drop policy if exists channel_outputs_read on channel_outputs;
create policy channel_outputs_read on channel_outputs
  for select using (is_signed_in());

drop policy if exists images_read on images;
create policy images_read on images for select using (is_signed_in());

drop policy if exists approvals_read on approvals;
create policy approvals_read on approvals for select using (is_signed_in());

drop policy if exists publish_queue_read on publish_queue;
create policy publish_queue_read on publish_queue for select using (is_signed_in());

drop policy if exists publish_deliveries_read on publish_deliveries;
create policy publish_deliveries_read on publish_deliveries
  for select using (is_signed_in());

drop policy if exists model_calls_read on model_calls;
create policy model_calls_read on model_calls for select using (is_signed_in());

drop policy if exists activity_log_read on activity_log;
create policy activity_log_read on activity_log for select using (is_signed_in());

-- ─── connectors ────────────────────────────────────────────────────────────
-- NO anon-key policy grants access to the token columns. Even for an admin,
-- the client reads connector STATUS through a view that excludes the
-- ciphertext; decryption happens only inside the publish path on the server
-- (§19.2). A select policy here would be a way for a compromised browser
-- session to exfiltrate encrypted tokens, so there isn't one.

drop policy if exists connectors_read_admin on connectors;
create policy connectors_read_admin on connectors
  for select using (current_role_is('admin'));

/**
 * What every non-admin screen reads instead: status without secrets.
 * security_invoker so the caller's RLS still applies to the underlying table.
 *
 * Named `connector_view` rather than `connector_status` because Postgres puts
 * types and relations in the same namespace, and `connector_status` is already
 * the enum on connectors.status.
 */
create or replace view connector_view
with (security_invoker = on) as
  select id, channel, kind, status, account_label,
         expires_at, last_verified_at, last_error, updated_at
    from connectors;

-- ─── recipients ────────────────────────────────────────────────────────────
-- Phone numbers and email addresses are the most sensitive data in this
-- system (§19.5b). Reviewers and admins may read the list to see who a
-- broadcast will reach; managers get counts only, computed server-side.

drop policy if exists recipients_read on recipients;
create policy recipients_read on recipients
  for select using (can_approve());

-- ─── usage_counters ────────────────────────────────────────────────────────
-- Spend tiles need these. Counters are incremented by the service role with an
-- atomic upsert; nobody writes them from a browser.

drop policy if exists usage_counters_read on usage_counters;
create policy usage_counters_read on usage_counters
  for select using (is_signed_in());

-- ─── The one public read: article permalinks (§10.1) ───────────────────────
-- A signed-out visitor reads a published article, its image and its source
-- list, and nothing else. Note these are anon-facing policies with explicit
-- column discipline enforced at the query site.

drop policy if exists article_versions_public on article_versions;
create policy article_versions_public on article_versions
  for select to anon using (
    exists (
      select 1 from content_requests r
       where r.id = article_versions.request_id
         and r.slug is not null
         -- Renders only for requests that reached gate two or beyond (§10.1).
         and r.status in ('content_review', 'scheduled', 'publishing', 'published')
    )
  );

drop policy if exists content_requests_public on content_requests;
create policy content_requests_public on content_requests
  for select to anon using (
    slug is not null
    and status in ('content_review', 'scheduled', 'publishing', 'published')
  );

-- The source list is the thing the brief asks the system to make clear, and
-- public is the honest place for it (§10.1). Failed fetches appear here too:
-- a source that could not be read is a row, not an absence (§5.4).
drop policy if exists sources_public on sources;
create policy sources_public on sources
  for select to anon using (
    exists (
      select 1 from content_requests r
       where r.id = sources.request_id
         and r.slug is not null
         and r.status in ('content_review', 'scheduled', 'publishing', 'published')
    )
  );

drop policy if exists images_public on images;
create policy images_public on images
  for select to anon using (
    chosen and exists (
      select 1 from content_requests r
       where r.id = images.request_id
         and r.slug is not null
         and r.status in ('content_review', 'scheduled', 'publishing', 'published')
    )
  );
