-- ═══════════════════════════════════════════════════════════════════════════
-- Recovers approvals that were stranded by the missing-queue-row bug.
--
-- Before 0016/0017 there was no way to store "approved, no send time", so the
-- approval action skipped the queue insert and logged a line about a row it
-- never created. Those channel_outputs sit at `approved` with nothing in
-- publish_queue: approved work that appears on no screen.
--
-- Now that `held` exists, each one gets the row it should always have had.
-- The approval it points at is real and already recorded in `approvals`, so
-- `approved_by` and `approved_at` come from there rather than being invented.
-- ═══════════════════════════════════════════════════════════════════════════

insert into content_agent.publish_queue (
  request_id, channel_output_id, channel, kind,
  scheduled_for, status, approved_by, approved_at, idempotency_key
)
select
  co.request_id,
  co.id,
  co.channel,
  -- Matches CHANNEL_DEFAULT_KIND: the newsletter is the only channel this
  -- system sends itself.
  case when co.channel = 'newsletter' then 'delivering' else 'handoff' end::content_agent.connector_kind,
  null,
  'held',
  a.actor_id,
  a.created_at,
  co.id::text || ':' || co.channel::text
from content_agent.channel_outputs co
join lateral (
  select actor_id, created_at
    from content_agent.approvals
   where subject_id = co.id
     and subject_type = 'channel_output'
     and decision = 'approved'
   order by created_at desc
   limit 1
) a on true
where co.status = 'approved'
  and not exists (
    select 1 from content_agent.publish_queue q where q.channel_output_id = co.id
  );

notify pgrst, 'reload schema';
