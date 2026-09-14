-- ═══════════════════════════════════════════════════════════════════════════
-- A timed-out delivery is `uncertain`, not `failed`.
--
-- `sweep_stuck_deliveries` marked a stuck `pending` row as `failed`, and the
-- worker re-sends anything that is not `sent` or `delivered`. So a delivery
-- that timed out — and may well have gone out — was re-sent on the next
-- attempt, and that subscriber received the newsletter twice.
--
-- This contradicts rule 9b ("nobody receives the same broadcast twice") and it
-- was inconsistent with `sweep_stuck_publishing` immediately above it, which
-- already used `uncertain` for exactly this reason: retrying an unknown write
-- is how you send twice.
--
-- DESIGN.md §15.5: "A timeout means the message may or may not have gone.
-- Retrying is how one recipient gets the same broadcast twice." That applies
-- per recipient as much as per queue row.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = content_agent, public, extensions;

-- Postgres cannot add an enum value inside a transaction that then uses it, so
-- this is idempotent and the value is referenced only by later statements.
do $$
begin
  if not exists (
    select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'content_agent'
       and t.typname = 'delivery_status'
       and e.enumlabel = 'uncertain'
  ) then
    alter type content_agent.delivery_status add value 'uncertain';
  end if;
end $$;
