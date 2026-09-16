-- ═══════════════════════════════════════════════════════════════════════════
-- Send every request with no excerpts back to indexing.
--
-- 0011 cleared the Voyage vectors but only rewound requests whose STATUS was
-- still 'researching'. A request that had already reached plan_review kept its
-- angles and its position in the pipeline while its entire corpus was gone —
-- so the next step would have drafted an article from zero excerpts.
--
-- That is the one thing this system must never do (rule 1: nothing is published
-- that is not traceable to a stored excerpt). Drafting would have failed on
-- marker resolution rather than inventing citations, so the guard held — but it
-- would have failed three steps and two model calls after the real cause.
--
-- The condition to key on is the actual fact, not a status word: a request that
-- has usable sources but no excerpts cannot proceed, whatever step it thinks it
-- is on. Angles are left in place; they were derived from real material and are
-- re-validated against the rebuilt corpus when planning runs again.
-- ═══════════════════════════════════════════════════════════════════════════

update content_agent.content_requests r
   set status       = 'researching',
       current_step = 'chunk_embed'
 where not exists (
         select 1 from content_agent.excerpts e where e.request_id = r.id
       )
   and exists (
         select 1 from content_agent.sources s
          where s.request_id = r.id
            and s.fetch_status in ('ok', 'too_large', 'redirected_offsite')
       )
   -- Terminal states stay terminal: a cancelled or published request is not
   -- resurrected by a change of embedding provider.
   and r.status in (
         'researching', 'plan_review', 'drafting', 'evaluating',
         'revising', 'adapting', 'content_review'
       );

notify pgrst, 'reload schema';
