-- ═══════════════════════════════════════════════════════════════════════════
-- Soft delete, so spend survives; and a flag for auto-trimmed channel posts.
--
-- Deleting a request used to remove the row, which cascaded to `model_calls`
-- and took its costs with it. "Spent this month" then read $0 after a clear-out
-- even though the money had genuinely been spent. A cost report that a delete
-- can rewrite is not a cost report.
--
-- Money spent is a fact about the past. Nothing a user does later makes it
-- untrue, so the row stays and is hidden instead.
-- ═══════════════════════════════════════════════════════════════════════════

alter table content_agent.content_requests
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references content_agent.profiles(id);

comment on column content_agent.content_requests.deleted_at is
  'Set when a user deletes the request. The row and its model_calls remain so '
  'spend totals stay truthful; every list filters on this being null.';

-- Every "where is it" query filters on this, so it earns an index.
create index if not exists content_requests_deleted_at_idx
  on content_agent.content_requests (deleted_at)
  where deleted_at is null;

-- Set when the X post was shortened in code to fit 280 characters, so the
-- edit is visible on the approval screen rather than silent.
alter table content_agent.channel_outputs
  add column if not exists auto_trimmed boolean not null default false;

comment on column content_agent.channel_outputs.auto_trimmed is
  'True when the body was mechanically shortened to fit the channel limit '
  'after the model overshot twice.';

-- ── Views must be rebuilt: `select *` froze their column lists at creation ──
create or replace view public.ca_content_requests
with (security_invoker = on) as
  select * from content_agent.content_requests;

create or replace view public.ca_channel_outputs
with (security_invoker = on) as
  select * from content_agent.channel_outputs;

grant select, insert, update, delete
  on public.ca_content_requests, public.ca_channel_outputs to service_role;
grant select on public.ca_content_requests, public.ca_channel_outputs to authenticated, anon;

-- ── Dashboard counts exclude deleted requests, but NOT deleted spend ──
-- The asymmetry is the entire point: a deleted request should stop appearing
-- in work queues while the money it cost still counts against the month.
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
    -- Deliberately NOT filtered by deleted_at: the spend happened.
    (select coalesce(sum(cost_cents), 0) from model_calls
      where created_at >= date_trunc('month', now())),
    (select bool_and(cost_complete) from content_requests
      where created_at >= date_trunc('month', now()));
$$;

revoke execute on function dashboard_counts() from public, anon, authenticated;
grant execute on function dashboard_counts() to service_role;

notify pgrst, 'reload schema';
