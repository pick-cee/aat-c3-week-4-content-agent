-- ═══════════════════════════════════════════════════════════════════════════
-- The lease can never outlive the function that holds it.
--
-- A lease is a promise that someone is working. When the holder dies, nothing
-- releases it: the request is frozen until it expires. So the ceiling must be
-- just above the longest a step can physically live, which is `maxDuration`
-- on the runner route (60s).
--
-- This was 90 in SQL and 300 in TypeScript at one point, and a dead worker
-- held a request for five minutes while the UI insisted another worker was
-- advancing it. Callers disagreeing about the number is exactly the failure
-- this prevents: the database now clamps it, so no caller can hold a request
-- longer than the platform would let it work.
--
-- 75 seconds: 60 for the function, plus room for the response and the release
-- write.
-- ═══════════════════════════════════════════════════════════════════════════

-- The return type changes from a scalar composite to setof, so the old
-- function must go first: "nothing to claim" should be zero rows, not a row
-- of nulls that a truthiness check waves through.
drop function if exists public.claim_request_lease(uuid, text, int);
drop function if exists content_agent.claim_request_lease(uuid, text, int);

create function content_agent.claim_request_lease(
  p_request_id uuid,
  p_lease_id   text,
  p_lease_secs int default 75
)
returns setof content_agent.content_requests
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update content_requests
     set runner_lease_until = now() + make_interval(
           -- Clamped, not trusted. A caller asking for 300 gets 75.
           secs => least(greatest(coalesce(p_lease_secs, 75), 15), 75)
         ),
         runner_lease_id    = p_lease_id
   where id = p_request_id
     and (runner_lease_until is null or runner_lease_until < now())
  returning *;
$$;

revoke execute on function content_agent.claim_request_lease(uuid, text, int)
  from public, anon, authenticated;
grant execute on function content_agent.claim_request_lease(uuid, text, int) to service_role;

create function public.claim_request_lease(p_request_id uuid, p_lease_id text, p_lease_secs int default 75)
returns setof content_agent.content_requests
language sql volatile as $$
  select * from content_agent.claim_request_lease(p_request_id, p_lease_id, p_lease_secs);
$$;

revoke execute on function public.claim_request_lease(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.claim_request_lease(uuid, text, int) to service_role;

-- Release every lease that outlives what a function could possibly hold: these
-- are dead workers from before the cap, and nothing else will free them.
update content_agent.content_requests
   set runner_lease_id = null, runner_lease_until = null
 where runner_lease_until > now() + interval '75 seconds';

notify pgrst, 'reload schema';
