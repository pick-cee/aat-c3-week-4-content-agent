-- ═══════════════════════════════════════════════════════════════════════════
-- Re-embed after the embedding provider changed (Voyage → OpenAI).
--
-- A cosine similarity between a Voyage vector and an OpenAI vector is not a
-- weak score — it is a MEANINGLESS one. The two models place text in unrelated
-- spaces, so comparing across them produces a number that looks like a
-- grounding score and carries no information at all.
--
-- That is the failure this system exists to avoid: a plausible-looking value
-- with nothing behind it. Every §8.4 grounding check and every relevance score
-- computed against a mixed corpus would be fiction.
--
-- So the old vectors go. Excerpts are derived data — the markdown they were
-- chunked from is still on `sources`, so clearing them costs one re-index and
-- no re-scraping (no Firecrawl credits are spent).
--
-- Deliberately NOT idempotent-by-accident: it only clears rows that exist when
-- it runs, and it is recorded in the ledger so it runs exactly once.
-- ═══════════════════════════════════════════════════════════════════════════

-- Excerpts are rebuilt by the chunk_embed step from source.markdown.
delete from content_agent.excerpts;

-- Relevance was computed from those vectors, so it is no longer meaningful.
update content_agent.sources
   set relevance_score = null,
       embed_failed    = false,
       embed_retryable = false,
       embed_attempts  = 0,
       embed_error     = null;

-- Any request that had finished indexing must pass through chunk_embed again.
-- Requests already past research keep their articles; only the corpus behind
-- them is rebuilt, and drafting reads excerpts fresh.
update content_agent.content_requests
   set current_step = 'chunk_embed'
 where status = 'researching'
   and current_step in ('score', 'plan');

notify pgrst, 'reload schema';
