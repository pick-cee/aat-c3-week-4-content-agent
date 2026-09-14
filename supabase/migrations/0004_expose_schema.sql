-- ═══════════════════════════════════════════════════════════════════════════
-- Expose `content_agent` to PostgREST.
--
-- A schema outside `public` is invisible to the Supabase client until the API
-- roles are granted usage on it. Without this, every query returns
-- "The schema must be one of the following: public" rather than a missing
-- table, which is a confusing way to learn about a permissions gap.
--
-- `anon` gets usage because the article permalink is a deliberate public read
-- (§10.1); what it may actually SELECT is still decided by the RLS policies in
-- 0002, which is where that boundary belongs.
-- ═══════════════════════════════════════════════════════════════════════════

grant usage on schema content_agent to anon, authenticated, service_role;

grant select on all tables in schema content_agent to anon, authenticated;
grant all on all tables in schema content_agent to service_role;
grant all on all sequences in schema content_agent to service_role;
-- EXECUTE is deliberately NOT granted here. These functions are SECURITY
-- DEFINER and bypass RLS; a blanket grant to anon and authenticated is the
-- hole 0007 closes, and it was unreachable only because `content_agent` is
-- absent from Supabase's exposure allowlist — a dashboard setting rather than
-- a guarantee. 0007 grants execute per function, to the roles that need it.

-- Anything created later inherits the same grants, so a table added in a
-- future migration is not silently unreachable.
alter default privileges in schema content_agent
  grant select on tables to anon, authenticated;
alter default privileges in schema content_agent
  grant all on tables to service_role;
alter default privileges in schema content_agent
  grant all on sequences to service_role;
-- No default EXECUTE grant. 0007 revokes it from public and anon by default
-- precisely so a function added in a later migration is not silently callable
-- by a stranger holding the anon key.

-- PostgREST caches the schema it knows about; without this it keeps reporting
-- "table not found in the schema cache" until the pooler restarts.
notify pgrst, 'reload schema';
