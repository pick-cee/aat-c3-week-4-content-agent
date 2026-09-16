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
LinkedIn, X and an email newsletter, and — after a human approves — releases it
on a schedule.

> **Three channels, not four.** DESIGN.md §2.12 proposed WhatsApp as a fourth.
> It was dropped. The code and schema are the authority here; where this
> document or DESIGN.md still describes a WhatsApp broadcast, the code is right.

**Two kinds of channel, and the distinction matters everywhere.** The newsletter
is _delivering_: the system sends it itself. LinkedIn and X are
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
Firecrawl · OpenAI embeddings · Resend. TypeScript throughout.

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
not yet `sent`, `delivered` **or `uncertain`**. Nobody receives the same
broadcast twice — sending a newsletter to the same subscriber twice is the most
visible mistake this system could make.

The `uncertain` half of that is the one that was wrong. A delivery whose
provider never responded used to be recorded as `failed`, and the retry
re-sent it. A failed send is safe to retry because the provider told us it did
not go; an unknown one is not, for exactly the reason §15.5 gives about queue
rows. The two cases are now distinct values, counted separately, and a
broadcast that includes one reads "37 of 40 delivered, 2 failed, 1 unknown"
rather than folding the unknown into either column.

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

11a. **A retry that cannot happen twice is not a retry.** A failure flag must
    record *why* it failed, not just *that* it did. `embed_failed` conflated a
    per-minute rate limit with a page that can never be embedded, and the
    pending filter excluded both forever — so six fetched articles of 20k–36k
    characters were refused once and never looked at again. Retrying the request
    could not recover them, because nothing re-examined them.

    The visible symptom appeared three steps and two model calls later as
    *"these three angles are too similar"*, which is a true observation with an
    entirely unrelated apparent cause. When a complaint points at a late stage,
    check what the early stages actually put in the table before tuning the
    prompt that produced the complaint.

    Any flag that gates future work carries a retryable/permanent distinction
    and an attempt count. Transient means try again with a backoff matched to
    the window being waited on — a per-minute quota is not cleared by a retry a
    second later — and the attempt cap is what keeps that terminating. Pacing to
    avoid the limit and backing off after hitting it are separate mechanisms;
    both are needed.

11c. **Never say "retrying" unless something will actually retry.** `runStep`
    returned `more: false` on every failure, retryable ones included. The runner
    wrote "Trying again (attempt 1 of 3)" to the log and the client poller — the
    only thing that performs that retry while a person is watching — read the
    same response and stopped. The retry never happened. The request sat at
    `evaluating` behind a spinner that never resolved, which is worse than an
    error: an error can be acted on.

    `more` means "a retry is coming", not "something went wrong", and
    `willRetryAfterFailure` is the single rule both sides read.

    The underlying failure was a BUDGET refusal, which evaluation had caught,
    retried once at identical cost, and flattened into a string — destroying
    the `BudgetExceededError` type the runner uses to route it to
    `budget_exceeded`. So a permanent condition was presented as a transient
    one, four attempts were spent proving it, and the message said "retrying
    usually clears it" about the one thing retrying can never clear. A typed
    error that carries "this cannot succeed later" must never be downgraded to
    a generic one.

    When a step cannot proceed, say what it needs and who can supply it. "Needs
    about $0.41, $0.19 left, raise the budget to $0.60 and run it again" is
    actionable. "The quality check could not complete" is not.

11d. **Approved work is never invisible.** A state with no representation in the
    schema becomes a code path that skips the write. `publish_queue.scheduled_for`
    was NOT NULL, so "approved, no send time yet" could not be stored — and the
    approval action logged "held in the queue" for a row it never created. The
    channel read `approved`, the request moved to `scheduled`, and the queue was
    empty. The item existed on no screen in the product.

    When a state is real, give it a value. `held` plus a nullable send time plus
    a check constraint keeping them consistent, rather than a branch that
    silently declines to insert. If a log line describes a row, that row exists.

    The same rule caught the other half: a gate that runs before the branch it
    depends on applies to cases it was never meant for. The connector check ran
    ahead of the `kind` branch and blocked every handoff item on a credential
    the design deliberately does not require. Order the guard after the
    distinction it relies on, and extract the rule so it can be tested.

11e. **One flag must not answer two questions.** Gate two derived a single
    `readOnly` from `status !== "content_review"` and used it for both "can the
    article be edited" and "can the channels be decided". Approving one channel
    moves the request to `scheduled`, so approving LinkedIn removed the approve
    button from the newsletter — which was still a draft, and which the server
    would have accepted. One approval silently ended the review, and the only
    way to use the product was to never approve anything until you had decided
    everything.

    The server never had the restriction. It was the UI locking itself, which
    is why nothing failed and no error appeared. `isArticleLocked` and
    `areChannelsLocked` are now separate, pure, and tested — a UI gate that
    silently removes an action is invisible to the type system and visible only
    by clicking the button once.

11f. **"Nothing found" must be falsy, and a failed write must not report
    success.** Two habits produced the same class of silent bug.

    `claim_due_publish_item()` was declared `returns publish_queue`, a scalar
    composite, so an UPDATE matching nothing returned a row with every field
    NULL. The guard `if (error || !data) return null` passed, because an object
    of nulls is truthy. The worker took the phantom for a real item and logged
    `channel_output <NULL> does not exist` on every sweep. `returns setof`
    returns zero rows, which is what "nothing" means; PostgREST then sends
    `[]`, which is ALSO truthy, so the guard checks the id rather than the
    container. A claim helper returns a row or null, never a shape that has to
    be interrogated at the call site.

    `cancelQueueItem` discarded the update error and returned `ok: true`
    regardless, so when a check constraint rejected the write the button
    reported success and did nothing. Every write checks its error and every
    failure reaches the person who asked for it.

    The constraint itself was mine: `(held and no time) or (not held and a
    time)` made cancelling a held row impossible, because cancelling leaves the
    time null. A constraint has to permit every legal transition out of the
    state it describes, not just the state itself.

11g. **A check must measure the artefact as it actually exists.** Three
    separate checks failed a good article, and every one was measuring
    something the pipeline does not produce at that moment.

    · The SEO check counted `[text](url)` markdown links. The model is
      FORBIDDEN from writing a URL (rule 3): it writes `((link: anchor | E12))`
      and the server substitutes at publish. So it reported zero links on an
      article with three, and no revision could pass, because passing would
      have meant breaking rule 3.

    · The figure check compared numbers as literal substrings, so `0.38` did
      not match a source writing `.38` and `4,312` did not match `4312`. It
      also captured trailing punctuation (`"38,"`) and pulled digits out of
      citation labels (`E14` became the figure `14`).

    · The tripwire scanned headings and table rows as prose and flagged each as
      an uncited claim. A marker cannot go on an H2 without rendering inside
      the heading.

    The article was never wrong. The checks were, and each wasted every
    revision round chasing a defect that did not exist. Before adding a check,
    write down what the artefact looks like AT THAT STEP: pre-substitution,
    pre-render, with its markers intact. A check that cannot be satisfied
    without violating another rule is not strict, it is broken.

11b. **A `grant` is not a boundary until the default is revoked.** Postgres
    grants EXECUTE to PUBLIC on every function it creates. Adding
    `grant execute … to service_role` therefore *adds* a grant without removing
    the default one — and because the `public.*` wrappers delegate to SECURITY
    DEFINER functions that bypass RLS, anyone holding the anon key that ships in
    the browser bundle could call them. Verified live: `claim_due_publish_item`
    returned HTTP 200 to the anon key, and `bump_counter` let a stranger burn
    the rate limits.

    Every new function needs an explicit REVOKE, and
    `alter default privileges … revoke execute` must cover the schema so the
    next one is not silently open. `npm run verify:grants` fails the build if
    anything is executable by `public`, `anon`, or by `authenticated` beyond the
    two named reads. The check is standing, not a one-time audit, because the
    default privilege is what caused this.

12. **Secrets are server-side only.** Anthropic, Firecrawl, OpenAI, Resend,
    Supabase service role, LinkedIn and X credentials never reach the browser.
    Connector tokens are encrypted at rest. `.env*` is gitignored before the
    first commit; a secret in git history is a leaked secret.

## Component structure

One screen is not one file. Gate two was 858 lines holding the article viewer,
the channel approver, the image picker, the source list, the version history and
the orchestration, and it threaded `pending`, `canApprove` and a callback per
action down through every panel.

Two concrete failures came out of that, neither visible to the type system:
approving one channel put a spinner on every button on the screen, because
`pending` was shared; and a single `readOnly` flag answered two different
questions, which locked the newsletter out of review.

- **A panel owns its actions.** It calls the server action itself and holds its
  own pending and error state (`review/use-action.ts`). A parent arranging
  transitions for its children is a parent owning state it does not use.
- **A component takes the facts it reads, not the object that contains them.**
  `ChannelsPanel` takes `holdInQueue` and `publishTarget`, never the whole
  `request` — passing the record couples every panel to every field.
- **The orchestrator composes.** `gate-two.tsx` decides which panel is showing
  and owns the article, because editing the article invalidates everything else
  on the page. Nothing else belongs there.
- **Rules that gate an action are pure, exported and tested**
  (`review-locks.ts`, `publish/gate.ts`). A UI gate that silently removes a
  button fails no test and throws no error; the only way to catch it is to make
  the rule a function with cases.

## Interface principle

Understandable in five seconds, readable after that. Status, ownership and
what-needs-me come first and visually. Prose supports; it is not the entry point.
Failed, blocked and uncertain items sort above everything else. A founder should
know the state of the operation without reading a paragraph.

**The machine does the arithmetic.** Anything with an exact mechanical answer is
computed, never handed back as a task. "Post weighs 326 characters and the limit
is 280, cut at least 46" is the system asking a founder to do its job; an X post
that overshoots twice is trimmed at a sentence boundary and marked as trimmed.
Judgment calls still go to a person — too few hashtags, a missing core idea, a
weak citation — but a number that can be satisfied exactly is satisfied.

**Evidence is shown whole.** A flagged claim truncated at 160 characters cannot
be checked, which defeats the point of flagging it. Advice is a list, not a
paragraph: five discrete changes can be read and worked through, while the same
five run together have to be unpicked first. Cap the count in the schema, since
structured outputs reject `maxItems`.

**Visual calibration** follows the tools this is measured against (Vercel,
Linear, Supabase): a 4px grid, hairline borders rather than shadows on every
card, 14px body with 13px secondary and 12px meta, tight tracking on headings
and normal on reading text, tabular figures for anything that updates, and one
accent colour — because colour means status here, and spending it on decoration
leaves nothing to say "this failed" with. Dark mode is a first-class palette,
not an inversion.

**Money spent is a fact about the past.** No later action makes it untrue.
Deleting a request hides it and keeps its costs; a cost report that a delete can
rewrite is not a report. Purging for good rolls the spend into a standalone
ledger that references nothing, so there is no row whose removal can take it
away.

**No em dashes in generated content.** They are the single clearest tell that a
machine wrote the text. Forbidden in the prompt on every call (`PUNCTUATION_BLOCK`,
which sits outside `brandVoiceBlock` because every call site applies that one
conditionally), and removed mechanically at `saveVersion` and `saveOutput` —
because asking a model not to use them does not reliably work, and rejecting a
whole draft over punctuation would spend a redraft on something with an exact
fix. The count that got through is logged, so "the prompt is working" is a
number rather than a hope.

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
  calls to Anthropic, Firecrawl, OpenAI, LinkedIn or X, ever.
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
