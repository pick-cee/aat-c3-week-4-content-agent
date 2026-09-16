-- ═══════════════════════════════════════════════════════════════════════════
-- A held item must be cancellable.
--
-- 0017 added: (status = 'held' and scheduled_for is null)
--          or (status <> 'held' and scheduled_for is not null)
--
-- The second branch is too strong. Cancelling a held row sets status to
-- 'cancelled' while scheduled_for stays null, which satisfies neither branch,
-- so the update was rejected. A held item could not be cancelled at all, and
-- because the action ignored the error and returned success, the button simply
-- did nothing.
--
-- What actually has to hold is narrower: a row that is WAITING TO SEND needs a
-- time, and a held row must not have one. A cancelled row is going nowhere, so
-- whether it has a time is irrelevant.
-- ═══════════════════════════════════════════════════════════════════════════

alter table content_agent.publish_queue
  drop constraint if exists held_has_no_time;

alter table content_agent.publish_queue
  add constraint held_has_no_time check (
    -- Held means approved with no time decided.
    (status = 'held' and scheduled_for is null)
    -- Anything the worker can claim must say when it is due.
    or (status = 'queued' and scheduled_for is not null)
    -- Every other state (cancelled, published, failed, uncertain, …) is a
    -- record of what happened, and imposing a time on it says nothing useful.
    or status not in ('held', 'queued')
  );

notify pgrst, 'reload schema';
