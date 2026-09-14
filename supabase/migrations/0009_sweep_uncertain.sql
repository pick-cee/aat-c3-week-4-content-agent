-- ═══════════════════════════════════════════════════════════════════════════
-- `sweep_stuck_deliveries` marks a timed-out send `uncertain`.
--
-- Separate from 0008 because Postgres refuses to use an enum value in the same
-- transaction that adds it.
--
-- The wording matters. A row that reaches this state is one we genuinely
-- cannot account for, and the text says so rather than implying failure —
-- someone reading the queue needs to know the difference between "this did not
-- send" and "we do not know whether this sent", because only one of them is
-- safe to retry.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = content_agent, public, extensions;

create or replace function content_agent.sweep_stuck_deliveries(p_minutes int default 5)
returns setof content_agent.publish_deliveries
language sql volatile security definer
set search_path = content_agent, public, extensions as $$
  update publish_deliveries
     set status     = 'uncertain',
         error_code = 'no_provider_response',
         error_text = 'The provider did not respond within ' || p_minutes
                      || ' minutes, so this message may or may not have been '
                      || 'delivered. It will NOT be retried automatically — '
                      || 're-sending an unknown delivery is how one recipient '
                      || 'receives the same message twice.'
   where status = 'pending'
     and created_at < now() - make_interval(mins => p_minutes)
  returning *;
$$;

-- The public wrapper's return type follows the table, so it is replaced too.
drop function if exists public.sweep_stuck_deliveries(int);

create or replace function public.sweep_stuck_deliveries(p_minutes int default 5)
returns setof content_agent.publish_deliveries
language sql volatile as $$
  select * from content_agent.sweep_stuck_deliveries(p_minutes);
$$;

-- 0007 revoked EXECUTE by default; a re-created function needs its grant back.
revoke execute on function public.sweep_stuck_deliveries(int) from public, anon, authenticated;
revoke execute on function content_agent.sweep_stuck_deliveries(int) from public, anon, authenticated;
grant execute on function public.sweep_stuck_deliveries(int) to service_role;
grant execute on function content_agent.sweep_stuck_deliveries(int) to service_role;

notify pgrst, 'reload schema';
