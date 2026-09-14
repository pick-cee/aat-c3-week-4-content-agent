# CLAUDE.md

Standing context for this repository. Read `DESIGN.md` before writing code — it
is the specification and it wins over convenience. Read `PRD.md` for the brief
and `assets/` for the SEO rules, channel formatting rules and evaluation rubric,
which are requirements, not suggestions.

## What this is

An AI content research and publishing agent for a marketing agency. A content
manager submits an idea or a URL. The system researches it, stores what it read,
proposes angles, drafts an SEO article grounded in stored excerpts, grades the
draft against a rubric, revises what fails, adapts the approved article for
LinkedIn, X, an email newsletter and a WhatsApp broadcast, and — after a human
approves — releases it on a schedule.

**Two kinds of channel, and the distinction matters everywhere.** The newsletter
and WhatsApp are _delivering_: the system sends them itself. LinkedIn and X are
_handoff_: their content is generated, format-checked, approved and scheduled
exactly like the others, but at the scheduled moment the system dispatches a
copy-ready packet to the person who posts it, and that person confirms with a
URL. X has no free API tier and LinkedIn's needs a verified app with no
read-back; neither credential came with the brief. Generating their content is
in scope and is graded. Posting on the agency's behalf is not something this
build can do honestly, so it does not pretend to. `DESIGN.md` §2.11.

Built for a course that grades production readiness: error handling and failure
visibility, edge cases, cost awareness, safety on repeated runs, and not leaking
secrets. Working on the happy path is the baseline, not the goal.

## Stack

Next.js (App Router) on Vercel · Supabase Postgres with pgvector · Anthropic API ·
Firecrawl · Voyage AI embeddings · Resend · WhatsApp Business Cloud API.
TypeScript throughout.

## Rules that are not negotiable

1. **Nothing is published that is not traceable to a stored excerpt.** All web
   content enters through one door: `sources` → `excerpts`. Generation steps
   receive labelled excerpts (`[E12]`) and nothing else. Every factual sentence
   carries a marker. A marker that does not resolve to an excerpt supplied to
   that call is a hard failure: discard the generation, log the tokens, retry
   once naming the bad ids, then stop the request.

2. **Verify the instruction, do not trust it.** The model is told to cite its
   claims. Measure whether it did. Marker integrity is checked in code. Cited
   sentences are compared to their excerpts by cosine distance, because a real
   citation on an unrelated claim passes every check that only looks at the
   marker. Unmarked sentences carrying numbers, dates, quotes or unknown proper
   nouns are flagged. If you can measure the outcome of an instruction, measure
   it.

3. **Never let a model write a URL.** Links are marked by intent and substituted
   server-side from the selected source's real URL. The same rule covers
   anything with a verifiable external referent. Remove the failure surface
   rather than detecting it afterwards.

4. **Channel outputs are derived from the approved article and nothing else.**
   No excerpts, no web access, no source corpus in the adapter prompt. A channel
   post cannot introduce a claim it has no material for. Markers are inherited
   and checked against the article's claim map. This holds for all four channels,
   including the two the system does not publish itself.

5. **Unknown is not zero, and unknown is not empty.** A source that failed to
   fetch is a row with a status and a reason, distinct from a source that was
   empty. A rubric criterion that could not be judged is `null` with a reason,
   never a score. An evaluation that did not run is `not_evaluated` and can
   never become `pass`. A dashboard count that could not be read renders "—",
   not "0". A cost total missing a call reads "at least $X".

6. **Publishing is impossible before approval, enforced server-side.** Queue
   rows are created only by the approval action; the worker re-checks approval
   and refuses otherwise; a check constraint backs both. The UI is not a
   security boundary.

7. **Reserve, then act, then confirm.** The publish worker claims a row with a
   single atomic `UPDATE … WHERE status = 'queued' … FOR UPDATE SKIP LOCKED
RETURNING *`, and the step runner claims a request with a conditional lease
   update. Never read-then-write. Idempotency lives in unique constraints —
   `publish_queue.idempotency_key`, `content_requests.submit_token`,
   `sources (request_id, url_canonical)` — not in application logic that checks
   first.

7b. **No pipeline step runs inside the user's request.** `POST /api/runner`
advances one request by one step and returns. Steps are sized to fit the
function budget and resume from stored state. A long-running route that dies
at the platform timeout leaves no record of where it got to, which is the
failure this whole build exists to avoid.

8. **A publish whose outcome is unknown is `uncertain`, and is never retried
   automatically.** Timeouts and dead workers go to `uncertain`, are reconciled
   by reading back from the platform where that is possible, and otherwise wait
   for a human to say whether it posted. Retrying an unknown write is how you
   put the same post on someone's LinkedIn twice.

9. **The system never shows a success it did not receive.** `published` means a
   provider returned an identifier, stored on the row. A handoff channel can
   never reach `published` — it reaches `awaiting_manual_post`, and only a
   person confirming with a URL makes it `posted_manually`, which stays visibly
   distinct. A broadcast where some recipients failed is
   `partially_delivered` with the real counts, never a status word alone. A
   channel with no authorised connector is `blocked_not_connected` and stays
   queued. A `DEMO_MODE` send is stored as a dry run, a distinct value.

9b. **Fan-out is idempotent per recipient, not per queue row.** `publish_deliveries`
is the record; a retry after a partial failure re-sends only to rows that are
not yet `sent`. Nobody receives the same broadcast twice — on WhatsApp that is
the most visible mistake this system could make.

9c. **Never message anyone without a consent record.** Opt-in is checked in the
send path, not only at import. Opt-out is immediate and permanent. A skipped
recipient is recorded as `skipped_no_optin` and counted, never silently
dropped. Contact details never reach a public page, `activity_log`, a
screenshot or the video.

10. **Every model call is logged, including discarded ones, and every call counts
    against the budget.** A rejected draft spent real money. `model_calls`
    carries every attempt with model, tokens and cost; `article_versions`
    carries only what survived. Budget is checked before every call, and
    crossing it stops the request at `budget_exceeded` with the work so far
    intact.

11. **Failures are visible, specific and owned.** Every failure sets a state
    naming the step, a plain-language reason, a structured detail, an
    `activity_log` row, and an email to the request's creator when terminal. A
    retry button appears only where retrying could actually help.

12. **Secrets are server-side only.** Anthropic, Firecrawl, Voyage, Resend,
    Supabase service role, LinkedIn and X credentials never reach the browser.
    Connector tokens are encrypted at rest. `.env*` is gitignored before the
    first commit; a secret in git history is a leaked secret.

## Interface principle

Understandable in five seconds, readable after that. Status, ownership and
what-needs-me come first and visually. Prose supports; it is not the entry point.
Failed, blocked and uncertain items sort above everything else. A founder should
know the state of the operation without reading a paragraph.

## Models

Assignment is per task, by the ratio of judgment to token volume, not per
project.

- **Haiku 4.5** — query planning with the `web_search` tool, angle planning,
  channel adaptation for all four channels, alt text. Short, rule-bound,
  schema-constrained.
- **Sonnet 5** — article drafting and revision. Publication-quality long-form
  prose, the largest token spend in the pipeline.
- **Opus 5** — evaluation. The judge reads one article and writes a paragraph,
  so judging costs roughly a third of what writing costs, and an extra cent buys
  more at the quality gate than it does at the keyboard.
- **No model at all** for chunking, relevance ranking, link resolution, format
  checks, keyword checks and word counts. A model call to do a splitter's job is
  money spent on nothing.

Record `model_used`, `input_tokens`, `output_tokens`, `cache_read_tokens` and
`web_searches` on every call, including ones whose output is discarded.

## API notes that will bite

- **Structured outputs and citations are mutually exclusive.** The API returns
  400 if both are enabled. Search calls use citations and parse JSON from a
  fenced block with a repair pass; every other structured call uses
  `output_config.format` with `strict: true`.
- `web_search` tool type is `web_search_20260318`; no beta header. Each search
  is $10/1,000 and counts even when it returns nothing.
- Firecrawl `maxAge` re-uses a cached scrape. Use it. Re-scraping a page we read
  last week is a paid no-op.
- **WhatsApp bills per message since July 2025.** A non-template message is only
  permitted inside a customer-initiated 24-hour service window, where it is free.
  Outside one, a business-initiated message needs an approved template, and a
  marketing template is charged at the recipient's country rate. Decide per
  recipient from `last_service_window_opened_at`; with no window and no approved
  template, block with that reason rather than calling the API and reading the
  refusal out of an opaque error.
- **WhatsApp is not markdown.** `*bold*`, `_italic_`, `~strike~`, triple-backtick
  mono. No headings, no `[text](url)`. Assert that no `**`, `#` or markdown link
  survives into a body.
- **Template parameters** may not contain a newline, a tab, or more than four
  consecutive spaces. Validate before the call; the API error for this is opaque
  and the cause is invisible in every UI.
- The developer test number sends free to an allowlist of up to five recipients.
  That is the demo path and it needs no business verification.
- Prices change. They live in one constants file with a `PRICES_VERIFIED_ON`
  date.

## Conventions

- Server actions or route handlers for anything touching a key. No client-side
  calls to Anthropic, Firecrawl, Voyage, LinkedIn or X, ever.
- The public article permalink at `/a/[slug]` selects an explicit column list.
  Never `select *` on a route that renders to signed-out visitors.
- Sentence segmentation uses `Intl.Segmenter`, never a split on `.`, because the
  claim map depends on it and "2.5%" would corrupt it silently.
- Character counts for X weigh URLs at 23 and most emoji at 2. Use the tested
  counter, not `String.length`.
- Phone numbers are stored and validated as E.164, rejected at import with the
  row number rather than at send time.
- The handoff confirmation link is a signed, expiring, single-row token. It is
  the one URL in this system a stranger could act on.
- Every state transition writes to `activity_log`.
- Rate limits and counters use an atomic upsert, never read-modify-write, and
  fail closed when the counter cannot be read.
- Prefer explicit failure over a plausible default.
- Thresholds and prices are named constants in one file, not literals scattered
  through the code.
- Comments explain _why_, not _what_.
- Print the data before reasoning about it. When a parse, a keyword match or a
  character count behaves impossibly, dump the raw bytes — an invisible
  character on a string cost hours once already.
