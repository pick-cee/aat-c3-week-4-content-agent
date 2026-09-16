-- ═══════════════════════════════════════════════════════════════════════════
-- Recommended changes become a LIST.
--
-- As a single text column the judge filled it with one dense paragraph — nine
-- separate edits run together, which a person has to disentangle before they
-- can act on any of them. A reviewer cannot tick off a paragraph.
--
-- Existing values are preserved as a single-item array rather than discarded:
-- an old evaluation's advice is still the advice that was given.
-- ═══════════════════════════════════════════════════════════════════════════

-- Postgres refuses to alter a column's type while a view selects it, and the
-- `ca_*` bridge views select every column. Dropped and rebuilt below.
drop view if exists public.ca_evaluations;

alter table content_agent.evaluations
  alter column recommended_changes type jsonb
  using case
    when recommended_changes is null then null
    when trim(recommended_changes) = '' then '[]'::jsonb
    else jsonb_build_array(recommended_changes)
  end;

alter table content_agent.evaluations
  alter column recommended_changes set default '[]'::jsonb;

comment on column content_agent.evaluations.recommended_changes is
  'Ordered list of concrete changes, most important first. A list rather than '
  'prose so each item can be read and acted on separately.';

create or replace view public.ca_evaluations
with (security_invoker = on) as
  select * from content_agent.evaluations;

grant select, insert, update, delete on public.ca_evaluations to service_role;
grant select on public.ca_evaluations to authenticated, anon;

notify pgrst, 'reload schema';
