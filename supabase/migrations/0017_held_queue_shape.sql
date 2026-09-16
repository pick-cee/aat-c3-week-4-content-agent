-- ═══════════════════════════════════════════════════════════════════════════
-- Makes a held queue row storable: a nullable send time, paired with the
-- 'held' status added in 0016.
--
-- The state now has a representation instead of a workaround, so approved work
-- is always a row somebody can see.
-- ═══════════════════════════════════════════════════════════════════════════

alter table content_agent.publish_queue
  alter column scheduled_for drop not null;

comment on column content_agent.publish_queue.scheduled_for is
  'When it goes out. NULL means approved but not yet scheduled, which pairs '
  'with status = held. A held row is real and visible; it is simply not due.';

-- A held row has no send time, and a row with a send time is not held. Both
-- halves are enforced so the two cannot drift apart.
alter table content_agent.publish_queue
  drop constraint if exists held_has_no_time;
alter table content_agent.publish_queue
  add constraint held_has_no_time check (
    (status = 'held' and scheduled_for is null)
    or (status <> 'held' and scheduled_for is not null)
  );

create or replace view public.ca_publish_queue
with (security_invoker = on) as
  select * from content_agent.publish_queue;

grant select, insert, update, delete on public.ca_publish_queue to service_role;
grant select on public.ca_publish_queue to authenticated, anon;

notify pgrst, 'reload schema';
