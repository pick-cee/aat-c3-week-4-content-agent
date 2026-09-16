-- ═══════════════════════════════════════════════════════════════════════════
-- Removes the seeded demo recipients.
--
-- Six rows were written on first boot so the broken-input pack had a recipient
-- to skip and one to count as opted out. That made sense for a fixture and
-- makes none for a real newsletter list: a founder opening Settings saw five
-- addresses they had never heard of, on a list they are responsible for.
--
-- Only rows the seed created are removed. `opt_in_source = 'seed:demo'` is
-- what the seeder writes, so an address a person actually added is untouched
-- however similar it looks.
-- ═══════════════════════════════════════════════════════════════════════════

delete from content_agent.recipients
 where opt_in_source = 'seed:demo';

notify pgrst, 'reload schema';
