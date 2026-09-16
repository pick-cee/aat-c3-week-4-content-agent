-- ═══════════════════════════════════════════════════════════════════════════
-- Spend that outlives the request it belonged to.
--
-- Soft delete keeps `model_calls` alive, so the monthly total stays correct
-- for anything in the recycle bin. Emptying the bin is the remaining hole:
-- deleting the request row cascades to model_calls and the month would drop
-- by whatever that request cost.
--
-- So before a permanent delete, the spend is rolled up into a standalone
-- ledger keyed by month. It references nothing, which is the point — there is
-- no row whose deletion can take it away.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists content_agent.retained_spend (
  id           uuid primary key default gen_random_uuid(),
  -- The month the spend belongs to, not when it was purged.
  month        date not null,
  request_id   uuid not null,
  cost_cents   numeric not null default 0,
  call_count   integer not null default 0,
  note         text,
  created_at   timestamptz not null default now(),
  -- Purging the same request twice must not double-count it.
  unique (request_id)
);

comment on table content_agent.retained_spend is
  'Costs of permanently deleted requests, kept so a monthly total can never '
  'understate what was actually spent. Deliberately has no foreign key.';

create index if not exists retained_spend_month_idx
  on content_agent.retained_spend (month);

alter table content_agent.retained_spend enable row level security;

-- Written only by the purge path running as service_role; readable by nobody
-- else directly (the dashboard reads it through dashboard_counts()).
create policy retained_spend_service_all on content_agent.retained_spend
  for all to service_role using (true) with check (true);

/**
 * Rolls one request's model spend into the ledger. Idempotent: purging the
 * same request twice leaves one row, never two.
 */
create or replace function content_agent.retain_request_spend(p_request_id uuid)
returns void
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  insert into retained_spend (month, request_id, cost_cents, call_count, note)
  select
    date_trunc('month', coalesce(min(m.created_at), now()))::date,
    p_request_id,
    coalesce(sum(m.cost_cents), 0),
    count(m.id),
    'Request permanently deleted; spend retained.'
  from model_calls m
  where m.request_id = p_request_id
  on conflict (request_id) do nothing;
$$;

revoke execute on function content_agent.retain_request_spend(uuid)
  from public, anon, authenticated;
grant execute on function content_agent.retain_request_spend(uuid) to service_role;

create or replace function public.retain_request_spend(p_request_id uuid)
returns void language sql volatile as $$
  select content_agent.retain_request_spend(p_request_id);
$$;

revoke execute on function public.retain_request_spend(uuid)
  from public, anon, authenticated;
grant execute on function public.retain_request_spend(uuid) to service_role;

-- ── The month's total is live spend plus retained spend ──
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
      where status in ('plan_review', 'content_review', 'needs_human')
        and deleted_at is null),
    (select count(*) from publish_queue
      where status = 'queued'
        and scheduled_for >= date_trunc('day', now())
        and scheduled_for <  date_trunc('day', now()) + interval '1 day'),
    (select count(*) from content_requests
      where status in ('failed', 'budget_exceeded')
        and deleted_at is null)
    + (select count(*) from publish_queue
        where status in ('failed', 'uncertain', 'blocked_not_connected')),
    -- Live calls (including those of soft-deleted requests) plus the costs of
    -- requests that were purged entirely.
    (select coalesce(sum(cost_cents), 0) from model_calls
      where created_at >= date_trunc('month', now()))
    + (select coalesce(sum(cost_cents), 0) from retained_spend
      where month = date_trunc('month', now())::date),
    (select bool_and(cost_complete) from content_requests
      where created_at >= date_trunc('month', now()));
$$;

revoke execute on function dashboard_counts() from public, anon, authenticated;
grant execute on function dashboard_counts() to service_role;

notify pgrst, 'reload schema';
