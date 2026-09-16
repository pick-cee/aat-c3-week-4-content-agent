-- ═══════════════════════════════════════════════════════════════════════════
-- Retryable embedding failures.
--
-- `embed_failed` conflated two different facts:
--
--   1. This page can never be embedded  — it produced no chunks at all.
--   2. This page was not embedded YET   — the provider returned 429 because
--                                         the per-minute quota was spent.
--
-- The chunk_embed step excluded both from re-indexing, so six articles of
-- 20k-36k characters were fetched, refused once, and then permanently skipped
-- on every subsequent attempt. Retrying the request could not recover them,
-- because nothing ever looked at them again. Two sources survived, the
-- two-sources-per-angle rule became unsatisfiable, and what the manager saw
-- three steps later was "these three angles are too similar".
--
-- Splitting the fact in two makes a transient failure retryable and leaves a
-- permanent one skipped, which is what §7.4 meant by "marked and excluded, but
-- never silently dropped".
-- ═══════════════════════════════════════════════════════════════════════════

alter table content_agent.sources
  add column if not exists embed_retryable boolean not null default false,
  add column if not exists embed_attempts  integer not null default 0;

comment on column content_agent.sources.embed_retryable is
  'True when the last embedding failure was transient (429, 5xx, timeout) and '
  'the source should be attempted again. False for permanent failures such as '
  'a page that produced no chunks.';

comment on column content_agent.sources.embed_attempts is
  'How many times embedding has been attempted for this source. Bounds the '
  'retry loop so a provider that is down for the whole run cannot starve the '
  'other sources of step invocations.';

-- Sources that failed BEFORE this migration have no recorded cause. Treat them
-- as retryable: attempting a page that turns out to be permanently unembeddable
-- costs one step invocation and then marks itself correctly, whereas leaving a
-- recoverable article excluded costs the draft its material.
update content_agent.sources
   set embed_retryable = true
 where embed_failed = true
   and embed_retryable = false;

-- `create or replace view ... select *` froze the column list when 0005 ran, so
-- the bridge must be rebuilt for the new columns to reach PostgREST at all.
create or replace view public.ca_sources
with (security_invoker = on) as
  select * from content_agent.sources;

grant select, insert, update, delete on public.ca_sources to service_role;
grant select on public.ca_sources to authenticated, anon;

notify pgrst, 'reload schema';
