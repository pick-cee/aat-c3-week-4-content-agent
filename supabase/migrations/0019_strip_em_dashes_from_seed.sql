-- ═══════════════════════════════════════════════════════════════════════════
-- Removes em dashes from seeded content.
--
-- `replaceEmDashes` runs on everything the models generate, but seeded rows
-- were written before that rule existed and never pass through it. So the
-- brand voice shipped as "Koya Talent — house voice" and the em dash appeared
-- on the settings page, in a product whose own rule is that they never appear.
--
-- The seed file is fixed too, but seeding only runs when the table is empty,
-- so existing installs need this.
-- ═══════════════════════════════════════════════════════════════════════════

update content_agent.brand_voices
   set name = btrim(regexp_replace(name, '\s*[—–―]\s*', ' ', 'g')),
       description = btrim(regexp_replace(coalesce(description, ''), '\s*[—–―]\s*', ', ', 'g'))
 where name ~ '[—–―]' or description ~ '[—–―]';

-- Tone rules and banned phrases are arrays; rebuild each element.
update content_agent.brand_voices v
   set tone_rules = sub.rules
  from (
    select id,
           array_agg(btrim(regexp_replace(rule, '\s*[—–―]\s*', ', ', 'g')) order by ord) as rules
      from content_agent.brand_voices, unnest(tone_rules) with ordinality as t(rule, ord)
     group by id
  ) sub
 where v.id = sub.id
   and exists (select 1 from unnest(v.tone_rules) r where r ~ '[—–―]');

notify pgrst, 'reload schema';
