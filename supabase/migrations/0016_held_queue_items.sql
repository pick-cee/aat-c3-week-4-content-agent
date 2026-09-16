-- ═══════════════════════════════════════════════════════════════════════════
-- Adds the 'held' publish status.
--
-- Alone in its own migration because Postgres refuses to USE a new enum value
-- in the same transaction that adds it, and the runner wraps each file in one.
-- The column change and the constraint that depend on this live in 0017.
--
-- Why it exists: `publish_queue.scheduled_for` was NOT NULL, so there was no
-- way to store "approved, but nobody has said when it goes out". The approval
-- action handled that by skipping the insert and logging "held in the queue" —
-- a message describing a row it never created. A channel showed `approved`,
-- the request moved to `scheduled`, and the queue was EMPTY. Approved work
-- existed on no screen at all.
-- ═══════════════════════════════════════════════════════════════════════════

alter type content_agent.publish_status add value if not exists 'held';
