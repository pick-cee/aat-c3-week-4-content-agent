-- ═══════════════════════════════════════════════════════════════════════════
-- "Nothing to claim" must return NO ROW, not a row of nulls.
--
-- `claim_due_publish_item()` was declared `returns publish_queue` — a scalar
-- composite. When the UPDATE matches nothing, Postgres returns a single value
-- of that type with every field NULL, and PostgREST hands that back as an
-- object. The worker's guard is `if (error || !data) return null`, and an
-- object full of nulls is truthy, so it sailed through.
--
-- The worker then treated the phantom as a real item:
--
--   [error] A queued item was refused because its content is not approved.
--           { error: 'channel_output <NULL> does not exist' }
--   [warn]  Could not record the failed outcome on a queue item.
--           { error: 'invalid input syntax for type uuid: "null"' }
--
-- Every sweep over an empty queue logged that pair. Harmless to the data, but
-- it fills the log with errors that describe nothing, which is how a real
-- error gets missed.
--
-- `returns setof content_agent.publish_queue` returns zero rows when nothing matches, which
-- is what "nothing was claimed" actually means. The same applies to
-- `claim_next_runnable_request`, which the runner guards identically.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists content_agent.claim_due_publish_item();

create function content_agent.claim_due_publish_item()
returns setof content_agent.publish_queue
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

revoke execute on function content_agent.claim_due_publish_item() from public, anon, authenticated;
grant execute on function content_agent.claim_due_publish_item() to service_role;

drop function if exists content_agent.claim_next_runnable_request(text, int);

create function content_agent.claim_next_runnable_request(
  p_lease_id   text,
  p_lease_secs int default 90
)
returns setof content_agent.content_requests
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update content_requests
     set runner_lease_until = now() + make_interval(secs => p_lease_secs),
         runner_lease_id    = p_lease_id
   where id = (
     select id from content_requests
      where status in ('researching', 'drafting', 'evaluating', 'revising', 'adapting')
        and deleted_at is null
        and (runner_lease_until is null or runner_lease_until < now())
      order by updated_at
      for update skip locked
      limit 1
   )
  returning *;
$$;

revoke execute on function content_agent.claim_next_runnable_request(text, int)
  from public, anon, authenticated;
grant execute on function content_agent.claim_next_runnable_request(text, int) to service_role;

-- The public wrappers must match the new return shape.
drop function if exists public.claim_due_publish_item();

create function public.claim_due_publish_item()
returns setof content_agent.publish_queue
language sql volatile as $$
  select * from content_agent.claim_due_publish_item();
$$;

revoke execute on function public.claim_due_publish_item()
  from public, anon, authenticated;
grant execute on function public.claim_due_publish_item() to service_role;

drop function if exists public.claim_next_runnable_request(text, int);

create function public.claim_next_runnable_request(p_lease_id text, p_lease_secs int default 90)
returns setof content_agent.content_requests
language sql volatile as $$
  select * from content_agent.claim_next_runnable_request(p_lease_id, p_lease_secs);
$$;

revoke execute on function public.claim_next_runnable_request(text, int)
  from public, anon, authenticated;
grant execute on function public.claim_next_runnable_request(text, int) to service_role;

notify pgrst, 'reload schema';
