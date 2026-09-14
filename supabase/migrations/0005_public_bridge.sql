-- ═══════════════════════════════════════════════════════════════════════════
-- Reaching `content_agent` through PostgREST.
--
-- The tables live in `content_agent` so they cannot collide with the other
-- application already in this project (see 0001). But PostgREST only serves
-- schemas on an allowlist held in Supabase's platform config — not in the
-- database — and it answers anything else with:
--
--     "Invalid schema: content_agent.
--      Only the following schemas are exposed: public, graphql_public"
--
-- Grants do not change that; it is a dashboard setting. Rather than make the
-- build depend on a console toggle somebody has to remember, each table is
-- exposed through `public` under a `ca_` prefix. The prefix is what keeps
-- `ca_profiles` from colliding with the other app's `public.profiles`.
--
-- These are simple single-table views, so Postgres makes them auto-updatable:
-- inserts, updates and deletes pass straight through to the real table, and
-- so do its constraints, defaults and triggers. `security_invoker` means the
-- caller's RLS still applies — the view is a name, not a way around 0002.
--
-- The isolation is unchanged. `public.ca_sources` and `public.sources` would
-- be different objects entirely; there is simply no `public.sources` here.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  t text;
  tables text[] := array[
    'profiles', 'brand_voices', 'content_requests', 'sources', 'excerpts',
    'angles', 'article_versions', 'evaluations', 'channel_outputs', 'images',
    'approvals', 'publish_queue', 'publish_deliveries', 'connectors',
    'recipients', 'model_calls', 'activity_log', 'usage_counters'
  ];
begin
  foreach t in array tables loop
    execute format(
      'create or replace view public.ca_%I with (security_invoker = on) as select * from content_agent.%I',
      t, t
    );

    -- service_role bypasses RLS and does every write that matters.
    execute format('grant select, insert, update, delete on public.ca_%I to service_role', t);
    -- What these two may actually see is decided by the policies in 0002,
    -- which still apply through security_invoker.
    execute format('grant select on public.ca_%I to authenticated, anon', t);
  end loop;
end $$;

-- The connector view is already the no-secrets projection (§19.2): it excludes
-- access_token_enc and refresh_token_enc. Read-only on purpose — nothing
-- should write a connector through a bridge.
create or replace view public.ca_connector_view
with (security_invoker = on) as
  select * from content_agent.connector_view;

grant select on public.ca_connector_view to service_role, authenticated, anon;

-- Without this the API keeps reporting "not found in the schema cache" until
-- something else happens to reload it.
notify pgrst, 'reload schema';
