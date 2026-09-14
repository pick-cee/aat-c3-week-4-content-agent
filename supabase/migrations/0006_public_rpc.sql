-- ═══════════════════════════════════════════════════════════════════════════
-- RPC wrappers in `public`.
--
-- Same reason as 0005: PostgREST only serves `public`, so the functions in
-- `content_agent` are unreachable from the client. Each wrapper is a thin
-- delegation, so the atomic statement — the thing that actually closes the
-- race in each case — stays in exactly one place and is not duplicated here.
--
-- These are SECURITY INVOKER (the default), so a caller gains nothing by going
-- through the wrapper that they would not have had calling directly: the inner
-- function's own SECURITY DEFINER still governs what it may touch.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── The step runner's lease (§3.1) ────────────────────────────────────────

create or replace function public.claim_request_lease(
  p_request_id uuid, p_lease_id text, p_lease_secs int default 90
) returns content_agent.content_requests
language sql volatile as $$
  select content_agent.claim_request_lease(p_request_id, p_lease_id, p_lease_secs);
$$;

create or replace function public.claim_next_runnable_request(
  p_lease_id text, p_lease_secs int default 90
) returns content_agent.content_requests
language sql volatile as $$
  select content_agent.claim_next_runnable_request(p_lease_id, p_lease_secs);
$$;

create or replace function public.release_request_lease(
  p_request_id uuid, p_lease_id text
) returns void
language sql volatile as $$
  select content_agent.release_request_lease(p_request_id, p_lease_id);
$$;

-- ─── The release worker (§15.2, §15.5) ─────────────────────────────────────

create or replace function public.claim_due_publish_item()
returns content_agent.publish_queue
language sql volatile as $$
  select content_agent.claim_due_publish_item();
$$;

create or replace function public.sweep_stuck_publishing(p_minutes int default 5)
returns setof content_agent.publish_queue
language sql volatile as $$
  select * from content_agent.sweep_stuck_publishing(p_minutes);
$$;

create or replace function public.sweep_stuck_deliveries(p_minutes int default 5)
returns setof content_agent.publish_deliveries
language sql volatile as $$
  select * from content_agent.sweep_stuck_deliveries(p_minutes);
$$;

-- ─── Counters and cost (§5.16, §18.4) ──────────────────────────────────────

create or replace function public.bump_counter(
  p_scope text, p_scope_key text, p_window text, p_metric text, p_cents numeric default 0
) returns int
language sql volatile as $$
  select content_agent.bump_counter(p_scope, p_scope_key, p_window, p_metric, p_cents);
$$;

create or replace function public.read_counter(
  p_scope text, p_scope_key text, p_window text, p_metric text
) returns int
language sql stable as $$
  select content_agent.read_counter(p_scope, p_scope_key, p_window, p_metric);
$$;

create or replace function public.add_request_cost(
  p_request_id uuid, p_cents numeric, p_complete boolean default true
) returns content_agent.content_requests
language sql volatile as $$
  select content_agent.add_request_cost(p_request_id, p_cents, p_complete);
$$;

-- ─── Vector search (§8.2, §7.5) ────────────────────────────────────────────

create or replace function public.match_excerpts(
  p_request_id uuid,
  p_embedding vector(512),
  p_limit int default 8,
  p_included_only boolean default true
) returns table (
  id uuid, source_id uuid, text text, heading_path text, ordinal int, similarity float
)
language sql stable as $$
  select * from content_agent.match_excerpts(p_request_id, p_embedding, p_limit, p_included_only);
$$;

create or replace function public.score_source_relevance(
  p_request_id uuid, p_embedding vector(512)
) returns void
language sql volatile as $$
  select content_agent.score_source_relevance(p_request_id, p_embedding);
$$;

-- ─── Approval gate (§14.3, enforcement point 2) ────────────────────────────

create or replace function public.assert_output_approved(p_channel_output_id uuid)
returns boolean
language sql stable as $$
  select content_agent.assert_output_approved(p_channel_output_id);
$$;

-- ─── Dashboard (§16) ───────────────────────────────────────────────────────

create or replace function public.dashboard_counts()
returns table (
  needs_you bigint,
  scheduled_today bigint,
  failed_blocked bigint,
  spent_month_cents numeric,
  spend_complete boolean
)
language sql stable as $$
  select * from content_agent.dashboard_counts();
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
-- service_role runs the pipeline; the two client roles need only the reads
-- that the dashboard and the runner poll depend on.

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

grant execute on function
  public.read_counter(text, text, text, text),
  public.dashboard_counts()
to authenticated;

notify pgrst, 'reload schema';
