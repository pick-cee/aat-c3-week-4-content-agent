-- ═══════════════════════════════════════════════════════════════════════════
-- A running step renews its own lease.
--
-- Capping the lease at 75 seconds stopped a DEAD worker freezing a request for
-- five minutes, which was right. But it also killed LIVE work: evaluation runs
-- the grounding embeddings and then an Opus judge, which together outlast 75
-- seconds, so the lease expired mid-step, another poller claimed the same
-- request, and the step restarted from the beginning.
--
-- Six attempts, zero judge calls, 21 cents spent, and the UI said "Evaluating"
-- for four minutes. An infinite loop that charges for every lap.
--
-- Both facts have to hold at once:
--   · a dead worker's claim expires quickly, because nothing else frees it
--   · a live worker keeps its claim for as long as it is genuinely working
--
-- A heartbeat is what distinguishes them. The lease stays short, and the
-- runner pushes it forward while the step is still running. A worker that dies
-- stops calling this, and its lease lapses on schedule.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function content_agent.renew_request_lease(
  p_request_id uuid,
  p_lease_id   text,
  p_lease_secs int default 75
)
returns boolean
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  with updated as (
    update content_requests
       set runner_lease_until = now() + make_interval(
             secs => least(greatest(coalesce(p_lease_secs, 75), 15), 75)
           )
     -- Only the holder may renew. A worker whose lease already lapsed and was
     -- taken by someone else must not steal it back mid-flight.
     where id = p_request_id
       and runner_lease_id = p_lease_id
    returning 1
  )
  select exists (select 1 from updated);
$$;

revoke execute on function content_agent.renew_request_lease(uuid, text, int)
  from public, anon, authenticated;
grant execute on function content_agent.renew_request_lease(uuid, text, int) to service_role;

create or replace function public.renew_request_lease(
  p_request_id uuid,
  p_lease_id   text,
  p_lease_secs int default 75
)
returns boolean language sql volatile as $$
  select content_agent.renew_request_lease(p_request_id, p_lease_id, p_lease_secs);
$$;

revoke execute on function public.renew_request_lease(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.renew_request_lease(uuid, text, int) to service_role;

notify pgrst, 'reload schema';
