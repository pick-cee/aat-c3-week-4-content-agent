-- ═══════════════════════════════════════════════════════════════════════════
-- Atomic operations. DESIGN.md rule 7: "Reserve, then act, then confirm.
-- Never read-then-write."
--
-- Every function here is a SINGLE statement that both tests and mutates. That
-- is the whole point: the test and the write cannot be separated by another
-- transaction. Splitting any of these into a select followed by an update
-- reintroduces exactly the race each one exists to close.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = content_agent, public, extensions;

-- ─── The step runner's lease. DESIGN.md §3.1. ──────────────────────────────
-- No row returned means another runner holds it and this invocation does
-- nothing. A lease that expires without the step completing is picked up by
-- the next invocation, which resumes from stored state rather than starting
-- over.

create or replace function claim_request_lease(
  p_request_id  uuid,
  p_lease_id    text,
  p_lease_secs  int default 90
) returns content_requests
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update content_requests
     set runner_lease_until = now() + make_interval(secs => p_lease_secs),
         runner_lease_id    = p_lease_id
   where id = p_request_id
     and (runner_lease_until is null or runner_lease_until < now())
  returning *;
$$;

/**
 * Find one request that is due to advance and claim it in the same statement.
 * Used by the cron safety net when nobody is watching the UI.
 */
create or replace function claim_next_runnable_request(
  p_lease_id   text,
  p_lease_secs int default 90
) returns content_requests
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update content_requests
     set runner_lease_until = now() + make_interval(secs => p_lease_secs),
         runner_lease_id    = p_lease_id
   where id = (
     select id from content_requests
      where status in ('researching', 'drafting', 'evaluating', 'revising', 'adapting')
        and (runner_lease_until is null or runner_lease_until < now())
      order by updated_at
      for update skip locked
      limit 1
   )
  returning *;
$$;

create or replace function release_request_lease(p_request_id uuid, p_lease_id text)
returns void language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update content_requests
     set runner_lease_until = null, runner_lease_id = null
   where id = p_request_id and runner_lease_id = p_lease_id;
$$;

-- ─── The release worker's claim. DESIGN.md §15.2. ──────────────────────────
-- One statement moves the row out of 'queued', so two overlapping cron
-- invocations cannot both claim it. Read-then-write would lose that race and
-- send twice, which on a newsletter means every subscriber gets the same email
-- twice. There is no unsending it.

create or replace function claim_due_publish_item()
returns publish_queue
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update publish_queue q
     set status      = 'publishing',
         attempt     = q.attempt + 1,
         reserved_at = now()
   where q.id = (
     select id from publish_queue
      where status = 'queued'
        and scheduled_for <= now()
      order by scheduled_for
      for update skip locked
      limit 1
   )
  returning q.*;
$$;

-- ─── The watchdog. DESIGN.md §15.5. ────────────────────────────────────────
-- A timeout means the message may or may not have gone. Retrying is how one
-- recipient gets the same broadcast twice, so a stuck row becomes `uncertain`
-- and waits for reconciliation or a human — it is never auto-retried.

create or replace function sweep_stuck_publishing(p_minutes int default 5)
returns setof publish_queue
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update publish_queue
     set status     = 'uncertain',
         last_error = 'Worker did not report an outcome within '
                      || p_minutes || ' minutes. The send may or may not have '
                      || 'completed, so it will not be retried automatically.'
   where status = 'publishing'
     and reserved_at < now() - make_interval(mins => p_minutes)
  returning *;
$$;

/** Same treatment for a per-recipient row whose send never reported back. */
create or replace function sweep_stuck_deliveries(p_minutes int default 5)
returns setof publish_deliveries
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update publish_deliveries
     set status     = 'failed',
         error_code = 'uncertain_timeout',
         error_text = 'No provider response within ' || p_minutes || ' minutes.'
   where status = 'pending'
     and created_at < now() - make_interval(mins => p_minutes)
  returning *;
$$;

-- ─── Rate limits and spend counters. DESIGN.md §5.16, §18.4. ───────────────
-- `insert … on conflict do update set count = count + 1` so two concurrent
-- requests cannot both read 9 and write 10.

create or replace function bump_counter(
  p_scope     text,
  p_scope_key text,
  p_window    text,
  p_metric    text,
  p_cents     numeric default 0
) returns int
language plpgsql volatile security definer set search_path = content_agent, public, extensions as $$
declare
  v_start timestamptz;
  v_count int;
begin
  v_start := date_trunc(
    case p_window
      when 'minute' then 'minute'
      when 'hour'   then 'hour'
      when 'day'    then 'day'
      else 'month'
    end, now());

  insert into usage_counters (scope, scope_key, window_size, window_start, metric, count, cents)
  values (p_scope, p_scope_key, p_window, v_start, p_metric, 1, p_cents)
  on conflict (scope, scope_key, window_size, window_start, metric)
  do update set count = usage_counters.count + 1,
                cents = usage_counters.cents + excluded.cents
  returning count into v_count;

  return v_count;
end;
$$;

create or replace function read_counter(
  p_scope text, p_scope_key text, p_window text, p_metric text
) returns int
language sql stable security definer set search_path = content_agent, public, extensions as $$
  select coalesce((
    select count from usage_counters
     where scope = p_scope and scope_key = p_scope_key
       and window_size = p_window and metric = p_metric
       and window_start = date_trunc(
         case p_window when 'minute' then 'minute'
                       when 'hour'   then 'hour'
                       when 'day'    then 'day'
                       else 'month' end, now())
  ), 0);
$$;

-- ─── Cost accounting. DESIGN.md §5.3, §18.4. ───────────────────────────────
-- Budget is checked before every call against the call's WORST CASE. Checking
-- after the fact is not a budget, it is a receipt.

create or replace function add_request_cost(
  p_request_id uuid,
  p_cents      numeric,
  p_complete   boolean default true
) returns content_requests
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update content_requests
     set actual_cost_cents = actual_cost_cents + ceil(p_cents)::int,
         -- Once false, stays false: a total that might be missing a call can
         -- never quietly become confident again.
         cost_complete     = cost_complete and p_complete
   where id = p_request_id
  returning *;
$$;

-- ─── Vector search over excerpts. DESIGN.md §8.2. ──────────────────────────
-- A 60k-token source pile becomes a 12k-token prompt, which is roughly a 75%
-- reduction on the input side of the most expensive call in the pipeline.

create or replace function match_excerpts(
  p_request_id uuid,
  p_embedding  vector(512),
  p_limit      int default 8,
  p_included_only boolean default true
) returns table (
  id           uuid,
  source_id    uuid,
  text         text,
  heading_path text,
  ordinal      int,
  similarity   float
)
language sql stable security definer set search_path = content_agent, public, extensions as $$
  select e.id, e.source_id, e.text, e.heading_path, e.ordinal,
         1 - (e.embedding <=> p_embedding) as similarity
    from excerpts e
    join sources s on s.id = e.source_id
   where e.request_id = p_request_id
     and e.embedding is not null
     -- A source the human unchecked at gate one cannot reach a draft. That is
     -- what makes "reviewed source material" true (§2.1).
     and (not p_included_only or s.included)
     and s.fetch_status = 'ok'
   order by e.embedding <=> p_embedding
   limit p_limit;
$$;

/**
 * Per-source relevance = max cosine similarity between any of its excerpts and
 * the embedded request. DESIGN.md §7.5. Nothing is auto-deleted; low scores
 * are shown collapsed and unchecked, with the score visible.
 */
create or replace function score_source_relevance(
  p_request_id uuid,
  p_embedding  vector(512)
) returns void
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update sources s
     set relevance_score = sub.score
    from (
      select e.source_id, max(1 - (e.embedding <=> p_embedding)) as score
        from excerpts e
       where e.request_id = p_request_id and e.embedding is not null
       group by e.source_id
    ) sub
   where s.id = sub.source_id and s.request_id = p_request_id;
$$;

-- ─── Publishing cannot precede approval. DESIGN.md §14.3, point 2. ─────────
-- The worker re-checks approval and refuses otherwise. This is enforcement
-- point 2 of 3; the NOT NULL columns on publish_queue are point 3, and the
-- fact that only the approval action inserts rows is point 1.

create or replace function assert_output_approved(p_channel_output_id uuid)
returns boolean
language plpgsql stable security definer set search_path = content_agent, public, extensions as $$
declare
  v_status channel_output_status;
  v_approval_count int;
begin
  select status into v_status from channel_outputs where id = p_channel_output_id;

  if v_status is null then
    raise exception 'channel_output % does not exist', p_channel_output_id
      using errcode = 'check_violation';
  end if;

  if v_status <> 'approved' then
    raise exception 'channel_output % is %, not approved', p_channel_output_id, v_status
      using errcode = 'check_violation';
  end if;

  select count(*) into v_approval_count
    from approvals
   where subject_type = 'channel_output'
     and subject_id = p_channel_output_id
     and decision = 'approved';

  if v_approval_count = 0 then
    raise exception 'channel_output % has no approval row', p_channel_output_id
      using errcode = 'check_violation';
  end if;

  return true;
end;
$$;

-- ─── Dashboard counts. DESIGN.md §16. ──────────────────────────────────────
-- Returned as one row so the tiles are one round trip. A tile that could not
-- be read renders "—", never "0" — that distinction is made in the UI, and it
-- depends on this either returning real numbers or throwing.

create or replace function dashboard_counts()
returns table (
  needs_you       bigint,
  scheduled_today bigint,
  failed_blocked  bigint,
  spent_month_cents numeric,
  spend_complete  boolean
)
language sql stable security definer set search_path = content_agent, public, extensions as $$
  select
    (select count(*) from content_requests
      where status in ('plan_review', 'content_review', 'needs_human')),
    (select count(*) from publish_queue
      where status = 'queued'
        and scheduled_for >= date_trunc('day', now())
        and scheduled_for <  date_trunc('day', now()) + interval '1 day'),
    (select count(*) from content_requests
      where status in ('failed', 'budget_exceeded'))
    + (select count(*) from publish_queue
        where status in ('failed', 'uncertain', 'blocked_not_connected')),
    (select coalesce(sum(cost_cents), 0) from model_calls
      where created_at >= date_trunc('month', now())),
    -- False if any request this month has an incomplete cost total, which the
    -- UI renders as "at least $X" (§5.3).
    (select bool_and(cost_complete) from content_requests
      where created_at >= date_trunc('month', now()));
$$;
