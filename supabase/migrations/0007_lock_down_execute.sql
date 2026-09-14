-- ═══════════════════════════════════════════════════════════════════════════
-- Close the anonymous RPC hole.
--
-- Postgres grants EXECUTE to PUBLIC by default on every function it creates.
-- Nothing revoked it, so the explicit `grant execute ... to service_role` in
-- 0006 ADDED a grant without removing the default one. The `public.*` wrappers
-- delegate to SECURITY DEFINER functions that bypass RLS, and PostgREST serves
-- `public` — so anyone holding the anon key that ships in the browser bundle
-- could call them.
--
-- Verified before writing this, against the live project:
--
--   claim_due_publish_item  -> HTTP 200, returned a queue row
--   bump_counter            -> HTTP 200, returned 1 (rate limits burnable)
--   sweep_stuck_publishing  -> HTTP 200 (queue rows forceable to `uncertain`)
--
-- A stranger could drag every scheduled item into `publishing`, where the
-- watchdog then marks it `uncertain` (§15.5) and it stops going out at all;
-- exhaust the per-IP and per-account rate limits; or push live requests into
-- `budget_exceeded` with `add_request_cost`.
--
-- The ALTER DEFAULT PRIVILEGES below is the part that matters most. Revoking
-- what exists today fixes today; the default privilege is what caused this,
-- and without changing it the next migration to add a function reopens the
-- hole silently.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Revoke what exists ────────────────────────────────────────────────────

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema content_agent from public, anon, authenticated;

-- ─── Stop it coming back ───────────────────────────────────────────────────
-- Applies to functions created LATER by the same role. Both schemas, because
-- `content_agent` is unreachable through PostgREST today only because it is
-- absent from Supabase's exposure allowlist — a dashboard setting, not a
-- guarantee, and not one this repository controls.

alter default privileges in schema public
  revoke execute on functions from public;
alter default privileges in schema public
  revoke execute on functions from anon;

alter default privileges in schema content_agent
  revoke execute on functions from public;
alter default privileges in schema content_agent
  revoke execute on functions from anon;

-- ─── Re-grant exactly what 0006 names ──────────────────────────────────────
-- service_role runs the pipeline and bypasses RLS; it is never exposed to a
-- browser (§19.1).

grant execute on all functions in schema content_agent to service_role;

grant execute on function
  public.claim_request_lease(uuid, text, int),
  public.claim_next_runnable_request(text, int),
  public.release_request_lease(uuid, text),
  public.claim_due_publish_item(),
  public.sweep_stuck_publishing(int),
  public.sweep_stuck_deliveries(int),
  public.bump_counter(text, text, text, text, numeric),
  public.read_counter(text, text, text, text),
  public.add_request_cost(uuid, numeric, boolean),
  public.match_excerpts(uuid, vector, int, boolean),
  public.score_source_relevance(uuid, vector),
  public.assert_output_approved(uuid),
  public.dashboard_counts()
to service_role;

-- The only two a signed-in person needs directly: the dashboard tiles and the
-- rate-limit display. Both are reads. Everything else goes through a server
-- action holding the service role.
grant execute on function
  public.read_counter(text, text, text, text),
  public.dashboard_counts()
to authenticated;

-- ─── The RLS helpers ───────────────────────────────────────────────────────
-- These are called BY the policies in 0002, evaluated as the querying role, so
-- that role must be able to execute them. They read `profiles` for the caller's
-- own row and return a boolean — they mutate nothing and leak nothing.

-- The enum is schema-qualified: this migration sets no search_path, and an
-- unqualified `user_role` does not resolve from `public`.
grant execute on function
  content_agent.current_role_is(content_agent.user_role),
  content_agent.can_approve(),
  content_agent.is_signed_in()
to anon, authenticated, service_role;

notify pgrst, 'reload schema';
