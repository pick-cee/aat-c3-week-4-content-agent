# DESIGN.md — AI Content Research and Publishing Agent

Specification for the Week 4 build. This document wins over convenience. If the
code and this document disagree, the document is what gets changed first, on
purpose, with a reason.

---

## 1. What this is

A content manager at a marketing agency submits an idea. The system researches
it, fetches and stores the source material, proposes three angles, drafts an SEO
article grounded in the stored sources, grades its own draft against a rubric,
revises what fails, and then adapts the approved article into a LinkedIn post, an
X post, an email newsletter and a WhatsApp broadcast. A human approves before
anything goes out. Approved content enters a publishing queue and is released on
schedule: the newsletter and the WhatsApp broadcast are sent for real, and the
two channels whose APIs are not available to this build are dispatched at the
scheduled moment as a copy-ready packet to the person who posts them.

The system is graded on production readiness, not feature count: failures must be
visible, edge cases handled, spend intentional, repeated runs safe, and secrets
never exposed. Working on the happy path is the floor.

**The single organising idea.** Every fact the system publishes can be traced to
a stored excerpt of a page we actually fetched, by an identifier that is checked
mechanically rather than trusted. Nothing downstream of research is allowed to
introduce new material. A model cannot cite a source that does not exist because
the citation is resolved against a table, and it cannot quietly attach a real
citation to an unrelated claim because the sentence and the excerpt are compared
by vector distance. Grounding is a property of the structure, not a thing we ask
the model to be careful about.

---

## 2. What the brief leaves open, and what we decided

The PRD is deliberately abstract. These are the decisions it does not make, and
the ones taken here.

**2.1 What "reviewed source material" means.** The brief says final content
should stay grounded in _reviewed_ source material. It never says who reviews
it. Decision: a human reviews the source set before any article is written.
Sources arrive with a relevance score and a one-line summary, everything above
threshold is pre-selected, and dropping one is a single click. The default path
costs the manager one button press; the capability to exclude a bad source
before it can contaminate a draft is what makes the word "reviewed" true.

**2.2 "Generate article options."** Ambiguous between three full articles and
three directions. Decision: three _angles_ — headline, outline, primary keyword,
and the excerpt set each would draw on. One is drafted in full after the human
picks. Drafting three complete articles to throw away two is roughly triple the
cost of the most expensive step in the pipeline for no extra information; the
choice a human actually makes is between directions, not between prose.

**2.3 How many human gates.** The brief asks for "a review step". Decision: two.
Gate one reviews sources and picks the angle on one screen. Gate two reviews the
article, the evaluation report and every channel output together, and
approves per channel. More gates would be defensible and would make the system
worse to use.

**2.4 Who searches and who fetches.** Decision: Claude's `web_search` server
tool decides _what to read_ — it formulates queries and returns ranked results.
Firecrawl does _the reading_ for every URL that matters, including URLs the
manager supplied. One ingestion path, one cache, one excerpt table. The
alternative — letting the model read pages directly through `web_fetch` — leaves
the raw material inside a model context we cannot query, diff or show to a
reviewer.

**2.5 Whether retrieval needs vectors.** For five sources and one article,
embeddings are usually decoration. They earn their place here for two reasons
that have nothing to do with retrieval fashion: they cut what goes into the
drafting call (cost), and they let us check whether a sentence actually relates
to the excerpt it cites (grounding). The second is the reason. See §8.4.

**2.6 What the evaluator is allowed to judge.** Decision: the rubric splits.
Source Grounding, Factual Consistency, SEO Fit and Channel Fit are largely
_computed_ from the artefacts before a model sees them. Topic Relevance,
Audience Fit, Tone, Clarity and Completeness are _judged_. A model grading its
own grounding is a model marking its own homework, and the parts that can be
measured should never be opinions.

**2.7 What happens when the evaluator keeps failing.** Decision: two revision
rounds, then the request stops at `needs_human` with every failing criterion,
every flagged claim and every draft version visible. It never ships a draft that
failed evaluation, and it never loops.

**2.8 Whether channel outputs may add anything.** Decision: no. They are derived
from the approved article alone and inherit its citations. A channel adapter
with no access to source material cannot invent a statistic. If a post needs a
fact the article does not contain, that is a signal the article is incomplete,
not a licence to fetch more.

**2.9 What "published" is allowed to mean.** Decision: it means a platform
returned an identifier for a live post or a delivered message, stored on the row.
A channel that only hands content to a human can never reach `published` on its
own — it reaches `awaiting_manual_post`, and only a person confirming with a URL
moves it to `posted_manually`, which is a distinct value and is labelled as such
everywhere it appears. A channel with no authorised connector shows
`blocked_not_connected` and stays queued. The system never displays a success it
did not receive.

**2.10 Images.** Decision: selected, never generated, from an openly licensed
library, with the licence, attribution and source URL stored alongside. An
invented image attached to a factually grounded article is a credibility
problem, and an image whose licence nobody recorded is a legal one. Alt text is
generated and is checked for length.

**2.11 Which channels the system actually sends to.** The brief names LinkedIn,
X and an email newsletter, and the deliverable requires all three as _content_.
It does not require that the system hold API credentials for platforms that no
longer give them away.

- **X** withdrew its free tier in February 2026. Posting is pay-per-use: $0.015
  a post, and $0.200 for a post containing a URL. There is no allowance.
- **LinkedIn** grants `w_member_social` self-service, but only after a LinkedIn
  Page exists to verify the developer app, only for the authenticated member's
  own profile, and with no way to read those posts back afterwards without a
  permission that requires partner review.
- The program supplied credentials for neither.

Decision: **adaptation for LinkedIn and X stays exactly as specified** — both
outputs are generated, format-checked against the platform rules and approved
like any other channel, because that is what the brief grades. What changes is
the last step. LinkedIn and X are _handoff_ channels: at the scheduled moment the
system dispatches a copy-ready packet to the person who will post it, and that
person confirms with a URL. Newsletter and WhatsApp are _delivering_ channels:
the system sends them itself.

This is not a workaround dressed up as a design. Agencies genuinely work this way
precisely because LinkedIn and X restrict programmatic posting, and a scheduled
handoff with a confirmation loop is a real product. It is also the only version
of this that stays honest: a simulated publish that renders "Published" is the
exact failure this program grades against, and an OAuth integration that breaks
on grading day is worse than one that was never claimed.

**2.12 Adding WhatsApp.** The agency is in Lagos. WhatsApp is where its audience
reads things, by a distance no other channel in the brief comes close to.
Decision: WhatsApp is a fourth channel — adapted, format-checked, opt-in gated
and genuinely delivered through the Cloud API. The brief does not ask for it. The
brief is a floor, and the strongest marks in this program have come from decisions
it never required.

**2.13 What the budget is for.** Decision: every request carries a budget in
cents, an estimate shown before research begins, and a running actual. Crossing
the budget stops the request at `budget_exceeded` and asks. An agent that
researches, drafts, evaluates and revises is an unbounded spend path unless
something bounds it.

---

## 3. The pipeline

```
draft
  └─ submit ─────────────────────────────────────────────┐
researching        discovery → fetch → chunk → embed      │
  └─ plan_review   ① human: confirm sources, pick angle   │
drafting           article v1 from selected excerpts      │
  └─ evaluating    computed checks + judged rubric        │
       ├─ pass ────────────────────────────────────┐      │
       ├─ revise (≤2) → revising → drafting vN+1 ──┘      │
       └─ reject ×3 → needs_human                        │
adapting           linkedin · x · newsletter · image       │
  └─ content_review ② human: approve per channel          │
scheduled → publishing → published                        │
                                                          │
any step → failed(step, reason) ──────────────────────────┘
any step → budget_exceeded
```

Terminal states: `published`, `needs_human`, `failed`, `budget_exceeded`,
`cancelled`. Every non-terminal state names the step that owns it, so a request
that dies halfway is never ambiguous about where it died. `needs_human` is
reachable from research as well as from evaluation — a topic that returns no
usable sources ends there, not in a drafted article.

**Resumability.** Each step is idempotent on its inputs and writes its output
before advancing the state. A request that fails at `adapting` re-runs
`adapting`; it does not re-research and it does not re-draft. Re-running a
completed step reuses stored output unless `force=true` is passed explicitly by
a human, which is logged.

### 3.1 The step runner, and why the pipeline is not one request

Research alone is a search call, six scrapes with retries, chunking and an
embedding batch. That does not reliably finish inside a serverless function's
execution budget, and a pipeline that dies at 60 seconds with no record of where
it got to is the opposite of what this build is for.

So no step runs inside the user's request. `POST /api/runner` advances **one
request by exactly one step** and returns. It is driven by the client polling
while a user is watching, and by the release cron as a safety net when nobody
is. Each step is sized to complete well inside the function limit; research is
itself split into `discover`, `fetch` (batched, four URLs per invocation),
`chunk_embed` and `score`, each resumable from what is already in the table.

Two runners must never process the same request. The runner claims work with the
same reserve-then-act statement the publish worker uses:

```sql
UPDATE content_requests
   SET runner_lease_until = now() + interval '90 seconds',
       runner_lease_id = $1
 WHERE id = $2
   AND (runner_lease_until IS NULL OR runner_lease_until < now())
RETURNING *;
```

No row returned means another runner holds it, and this invocation does nothing.
A lease that expires without the step completing is picked up by the next
invocation, which resumes from stored state rather than starting over. A step
that has exceeded `max_step_attempts` (3) stops the request at `failed` naming
the step, rather than retrying forever on a schedule.

---

## 4. Roles

Three roles on `profiles`, enforced server-side, never only in the UI.

| Role       | Can                                                                          |
| ---------- | ---------------------------------------------------------------------------- |
| `manager`  | Create requests, review sources, pick angles, request revisions, edit drafts |
| `reviewer` | Everything a manager can, plus approve content and schedule publishing       |
| `admin`    | Everything, plus connect and disconnect publishing accounts, set budgets     |

**The approver may be the author.** Week 3 separated them because a proposal
goes to a paying client and a wrong number is a commercial liability. Here the
risk is reputational and the team is small; forcing a second person to approve
every LinkedIn post would make the tool slower than writing the post by hand.
This is a deliberate reversal of a decision that was right in a different
context, and it is recorded as such.

Connecting a publishing account is admin-only, because that action grants the
system the ability to post as a real human being.

---

## 5. Data model

Postgres on Supabase. `pgvector` enabled. All timestamps `timestamptz`.

### 5.1 `profiles`

`id uuid pk` (= auth.users.id) · `email` · `full_name` · `role` enum · `created_at`

### 5.2 `brand_voices`

`id` · `name` · `description` · `audience_default` · `tone_rules text[]` ·
`banned_phrases text[]` · `cta_default` · `reading_level` · `is_default bool` ·
`created_by` · `created_at`

One row seeded for the agency. Fed into drafting and adaptation, and it is what
the rubric's Tone criterion is judged against — without a stored voice, "tone
matches the brand" is unfalsifiable.

### 5.3 `content_requests`

`id` · `created_by` · `slug text unique` · `idea text` · `target_audience text` ·
`primary_keyword text` · `seed_urls text[]` · `channels text[]` ·
`brand_voice_id` · `status` · `current_step` · `step_attempts int` ·
`runner_lease_until` · `runner_lease_id` · `failed_step` ·
`failure_reason text` · `failure_detail jsonb` · `budget_cents int` ·
`estimated_cost_cents int` · `actual_cost_cents int` ·
`cost_complete bool default true` · `revision_rounds int default 0` ·
`replans int default 0` · `submit_token text unique` ·
`created_at` · `updated_at`

`submit_token` is generated with the intake form and carried on submit, so a
double-click creates one request rather than two. The uniqueness is a database
constraint, not a disabled button.

`slug` is the public permalink segment. See §10.1.

`cost_complete` goes false if any `model_calls` insert failed. A cost total that
might be missing a call is displayed as "at least $X", never as a smaller
confident number.

### 5.4 `sources`

`id` · `request_id` · `url` · `url_canonical` · `origin` (`seed` | `discovered`) ·
`discovered_via_query text` · `title` · `site_name` · `author` · `published_at` ·
`fetch_status` · `fetch_error text` · `http_status int` · `content_hash` ·
`markdown_chars int` · `from_cache bool` · `relevance_score numeric` ·
`included bool` · `excluded_by` · `excluded_reason` · `credits_used int` ·
`fetched_at`

`unique (request_id, url_canonical)`.

`fetch_status` ∈ `pending` · `ok` · `fetch_failed` · `blocked` · `paywalled` ·
`empty` · `too_large` · `unsupported_type` · `redirected_offsite`.

**A source that could not be read is a row, not an absence.** `empty` (fetched,
nothing there) and `fetch_failed` (never fetched) are different values, because
in Week 2 a dead fetch and a genuinely empty result produced the same message
and that was useless. Both appear in the source list on the deliverable.

URL canonicalisation: lowercase host, strip `www.`, strip fragment, strip
tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, `mc_cid`), collapse trailing
slash. Two links to the same article do not become two sources, and the same
article across two requests still re-uses the Firecrawl cache.

### 5.5 `excerpts`

`id` · `source_id` · `request_id` · `ordinal int` · `text` ·
`heading_path text` · `char_start int` · `char_end int` · `token_estimate int` ·
`embedding vector(512)` · `created_at`

`index on embedding using hnsw (embedding vector_cosine_ops)`.

Chunking is deterministic: split on markdown headings, then pack paragraphs to
roughly 250–400 tokens without splitting a sentence, carrying the heading path.
No model is involved in chunking. A model call to do something a splitter does
is money spent on nothing.

### 5.6 `angles`

`id` · `request_id` · `label` · `headline` · `outline jsonb` ·
`primary_keyword` · `secondary_keywords text[]` · `excerpt_ids uuid[]` ·
`rationale text` · `chosen bool` · `model_used` · `created_at`

### 5.7 `article_versions`

`id` · `request_id` · `version int` · `angle_id` · `title` ·
`meta_description` · `body_md` · `primary_keyword` ·
`secondary_keywords text[]` · `word_count int` · `headings jsonb` ·
`claim_map jsonb` · `link_targets jsonb` · `origin` (`initial` | `revision` |
`human_edit`) · `parent_version_id` · `model_used` · `input_tokens` ·
`output_tokens` · `created_at`

`unique (request_id, version)`. Versions are never overwritten. The review
history the brief asks for is this table plus `evaluations`.

### 5.8 `evaluations`

`id` · `article_version_id` · `request_id` · `status` (`pass` | `revise` |
`reject` | `not_evaluated`) · `computed jsonb` · `judged jsonb` ·
`unsupported_claims jsonb` · `weak_citations jsonb` ·
`sections_to_revise jsonb` · `recommended_changes text` ·
`overall_note text` · `model_used` · `input_tokens` · `output_tokens` ·
`error text` · `created_at`

`not_evaluated` exists because an evaluation that could not run must never be
indistinguishable from one that passed. A request whose evaluation errored stops
at `failed`, it does not proceed on an assumed pass.

### 5.9 `channel_outputs`

`id` · `request_id` · `article_version_id` · `channel` (`linkedin` | `x` |
`newsletter` | `whatsapp`) · `version int` · `subject text` (newsletter) · `body text` ·
`hashtags text[]` · `cta text` · `includes_link bool` · `link_url text` ·
`char_count int` · `claim_map jsonb` · `format_check jsonb` ·
`status` (`draft` | `approved` | `rejected`) · `model_used` · `input_tokens` ·
`output_tokens` · `created_at`

`unique (request_id, channel, version)`.

### 5.10 `images`

`id` · `request_id` · `provider` · `provider_asset_id` · `source_page_url` ·
`download_url` · `storage_path` · `width` · `height` · `alt_text` ·
`licence` · `licence_url` · `attribution_text` · `query_used` · `chosen bool` ·
`created_at`

A row with no `licence` is never attached to content.

### 5.11 `approvals`

`id` · `request_id` · `subject_type` (`article` | `channel_output`) ·
`subject_id` · `actor_id` · `decision` (`approved` | `rejected` |
`revision_requested`) · `note text` · `created_at`

### 5.12 `publish_queue`

`id` · `request_id` · `channel_output_id` · `channel` · `scheduled_for` ·
`status` · `attempt int default 0` · `max_attempts int default 3` ·
`last_error text` · `platform_post_id text` · `platform_url text` ·
`idempotency_key text` · `approved_by uuid not null` ·
`approved_at timestamptz not null` · `estimated_cost_cents int` ·
`actual_cost_cents int` · `reserved_at` · `published_at` · `created_at`

`create unique index on publish_queue (channel_output_id) where status <> 'cancelled'`
— one live intent per approved output, while still allowing a cancelled item to
be re-queued. Same partial uniqueness on `idempotency_key`, which is
`channel_output_id || ':' || channel`.

`approved_by` and `approved_at` are `not null`, so a queue row cannot exist
without an approval. This is the third of the three enforcement points in
§14.3, and it is the one that holds even if both of the others are edited away.

`status` ∈ `queued` · `publishing` · `published` · `awaiting_manual_post` ·
`posted_manually` · `failed` · `uncertain` · `blocked_not_connected` ·
`partially_delivered` · `cancelled`.

`uncertain` is the state for a send whose outcome we do not know: a timeout, a
worker that died mid-flight, a 5xx after the request was accepted. It is never
auto-retried. §15.5 says what happens to it.

`awaiting_manual_post` and `posted_manually` belong to the handoff channels. A
handoff item can never reach `published`, and the distinction is preserved
everywhere it is displayed — a post a human made is a real post, and it is also
not something this system did.

`partially_delivered` belongs to fan-out channels. A WhatsApp broadcast to forty
recipients where three fail is neither published nor failed, and calling it
either would be a lie. Per-recipient outcomes live in `publish_deliveries`.

### 5.12a `publish_deliveries`

`id` · `queue_id` · `recipient_id` · `channel` · `status` (`pending` | `sent` |
`delivered` | `failed` | `skipped_no_optin`) · `provider_message_id` ·
`error_code` · `error_text` · `cost_cents` · `sent_at` · `updated_at`

`unique (queue_id, recipient_id)`. This is what makes a fan-out send idempotent
per recipient: a retry after a partial failure re-sends to the three that failed,
never to the thirty-seven that succeeded. A broadcast that duplicates itself on
WhatsApp is the most visible failure this system could produce.

### 5.13 `connectors`

`id` · `channel` · `kind` (`delivering` | `handoff`) · `status` (`connected` |
`not_connected` | `expired` | `revoked` | `error`) · `account_label` ·
`account_urn` · `scopes text[]` · `access_token_enc bytea` ·
`refresh_token_enc bytea` · `expires_at` · `connected_by` · `last_verified_at` ·
`last_error` · `updated_at`

`kind` is the property the publish worker branches on, not a hardcoded list of
channel names. If LinkedIn access is ever obtained, that channel becomes
`delivering` by changing one row, and no publishing code changes.

### 5.13a `recipients`

`id` · `channel` (`newsletter` | `whatsapp`) · `handle` (email or E.164 phone) ·
`display_name` · `opted_in_at` · `opt_in_source` · `opt_out_at` ·
`last_service_window_opened_at` · `created_at`

`unique (channel, handle)`.

**A recipient without `opted_in_at`, or with `opt_out_at` set, is never sent to.**
This is checked in the send path, not only at import, and a skipped recipient is
recorded as `skipped_no_optin` rather than silently dropped — the operator needs
to know the broadcast reached thirty-seven of forty and why.

`last_service_window_opened_at` tracks WhatsApp's customer-initiated 24-hour
window, which is what decides whether a message is free and whether a non-template
message is permitted at all. See §15.3.

Tokens are encrypted at rest with AES-256-GCM using a key held in an environment
variable, and are decrypted only inside the publish path on the server. They are
never selected into anything that reaches a client component.

### 5.14 `model_calls`

`id` · `request_id` · `step` · `purpose` · `model` · `input_tokens` ·
`output_tokens` · `cache_read_tokens` · `web_searches int` · `cost_cents` ·
`outcome` (`used` | `discarded` | `failed`) · `error` · `latency_ms` ·
`created_at`

**Every call is logged, including discarded ones.** A rejected draft cost real
money. `article_versions` keeps what survived; `model_calls` keeps what was
spent.

### 5.15 `activity_log`

`id` · `request_id` · `step` · `level` (`info` | `warn` | `error`) ·
`message text` · `detail jsonb` · `actor_id` · `created_at`

Every state transition writes a row. Every failure writes a row with a
plain-language `message` a non-engineer can read and a `detail` an engineer can
debug from.

### 5.16 `usage_counters`

`id` · `scope` (`global` | `profile` | `ip`) · `scope_key` · `window_start` ·
`window` (`minute` | `hour` | `day` | `month`) · `metric` · `count int` ·
`cents int`

`unique (scope, scope_key, window, window_start, metric)`. Incremented with
`insert … on conflict do update set count = usage_counters.count + 1`, so two
concurrent requests cannot both read 9 and write 10.

---

## 6. Intake

The manager submits:

| Field           | Required | Notes                                                                       |
| --------------- | -------- | --------------------------------------------------------------------------- |
| Idea            | yes      | Free text. The raw content idea.                                            |
| Target audience | yes      | Free text, or inherited from the brand voice.                               |
| Primary keyword | no       | Blank means the planner proposes one and the human confirms it at gate one. |
| Source URLs     | no       | Zero or more. Zero is the raw-idea path.                                    |
| Channels        | yes      | Any subset of LinkedIn, X, newsletter, WhatsApp. Defaults to all four.      |
| Brand voice     | yes      | Defaults to the agency default.                                             |
| Budget          | yes      | Defaults to 150 cents.                                                      |
| Publish target  | no       | A datetime, or "hold in queue".                                             |

**Validation before anything is spent.** Empty or near-empty idea (< 15
characters after trim) is rejected in the form. Seed URLs are parsed, and a
malformed one is rejected at submit rather than discovered as a fetch failure
three steps later. More than 10 seed URLs is rejected with a message, because
ingestion cost scales with it.

**The estimate.** On submit, before research starts, the user sees an estimated
cost band derived from the number of seed URLs, the channel count and the
configured search budget. If the estimate already exceeds the budget, the
request does not start.

---

## 7. Research

### 7.1 Discovery — raw-idea path

One Claude call with the `web_search` server tool (`web_search_20260318`,
`max_uses: 4`). The model is told the idea, the audience and the keyword, and
asked to find reference material and report which results are worth reading and
why. `blocked_domains` carries a small list of content farms and the agency's
own domain.

Search results come back with citations attached, which means this call cannot
use structured outputs — the API rejects the combination. The output is parsed
as a list of `{url, title, why, confidence}` from a fenced JSON block, with a
repair pass on malformed JSON before failing. This is the one place in the system
where JSON is not schema-guaranteed, and it is deliberate: the alternative is
losing search.

Zero results is **not** a failure and **not** an empty article. It sets
`research_outcome = 'no_sources_found'`, records the queries tried, and stops the
request at `needs_human` with the message that the topic returned nothing
usable. Week 2's lesson: a zero that looks like a number is worse than an error.

### 7.2 Discovery — URL path

Seed URLs skip search entirely. No search call is made when the manager supplied
URLs and the idea does not ask for more. This is a deliberate `$10/1000` saved on
every URL-based request, and it is the answer to "when should this automation
_not_ run".

A request with seed URLs _and_ a broad idea runs one search with `max_uses: 2`
to top up, flagged in the UI so the manager can see which sources they supplied
and which the system found.

### 7.3 Fetching

Every URL — seed or discovered — goes to Firecrawl `/v2/scrape` with
`formats: ["markdown"]`, `onlyMainContent: true`, and `maxAge: 604800000` (seven
days), so a page fetched for a previous request is re-used from cache rather than
re-scraped. Concurrency capped at 4.

Outcomes map to `fetch_status` explicitly:

| Condition                                  | Status                                               |
| ------------------------------------------ | ---------------------------------------------------- |
| 200, markdown ≥ 400 chars                  | `ok`                                                 |
| 200, markdown < 400 chars                  | `empty`                                              |
| 401/403, or paywall markers in content     | `paywalled`                                          |
| 404/410                                    | `fetch_failed`                                       |
| 429 after two backoffs                     | `fetch_failed` (rate limited, recorded as such)      |
| 5xx after two backoffs                     | `fetch_failed`                                       |
| Content-Type not html/pdf/text             | `unsupported_type`                                   |
| Markdown > 200k chars                      | `too_large` (truncated to 200k, flagged, still used) |
| Redirect to a different registrable domain | `redirected_offsite` (kept, flagged)                 |

Retries are two attempts with exponential backoff and jitter, on 429 and 5xx
only. A 404 is not retried, because retrying a 404 is spending money to be told
the same thing.

**Partial research is a valid outcome and must look like one.** If four of six
sources fetch and two fail, the request proceeds with four, and the two failures
are rows the reviewer sees at gate one and that appear on the published source
list. If _zero_ fetch successfully, the request stops. If fewer than two fetch
successfully and the request had no seed URLs, it stops — one source is not
research.

### 7.4 Chunking and embedding

Successful markdown is chunked (§5.5) and every chunk embedded with
`text-embedding-3-small` at 512 dimensions, in batches of 128, with
`input_type: "document"`. A source whose chunks could not be embedded is marked
and excluded from vector selection but remains available for manual inclusion,
with a visible note. It is never silently dropped.

**Transient and permanent failures are different facts.** Embedding rejection is
usually a per-minute rate limit, which says nothing about the page — so the
source is marked `embed_retryable` and attempted again on a later invocation, up
to `MAX_EMBED_ATTEMPTS` (3). A permanent failure, such as a page that produced no
chunks at all, is marked not-retryable and skipped from then on. A source that
later succeeds has the flag cleared, so the reviewer never sees a failure note on
a source that is indexed.

Two mechanisms protect against the rate limit, and they are not the same thing.
Requests are *paced* (a minimum gap between calls) to avoid hitting the limit,
and *backed off* in tens of seconds when one is hit anyway, because a per-minute
quota cannot be cleared by retrying a second later.

This is written down because conflating the two failures cost a whole run: six
articles of 20k–36k characters were fetched, refused once, and then permanently
excluded from re-indexing. Two sources survived, "two sources per angle" (§8.2)
became unsatisfiable, and the symptom that reached the manager three steps later
was *"these three angles are too similar"* — a complaint about angles, caused by
an embedding quota.

### 7.5 Relevance and selection

`relevance_score` per source = the maximum cosine similarity between any of its
excerpts and the embedded request (idea + audience + keyword, `input_type:
"query"`). Sources below 0.25 are shown collapsed and unchecked by default,
with the score visible. Nothing is auto-deleted.

---

## 8. The excerpt ledger, and how grounding is enforced

This is the section the rest of the system depends on.

### 8.1 The rule

The only raw material any generation step may use is a set of excerpt rows
selected from `excerpts`. Excerpts are presented to the model with stable
identifiers:

```
[E12] source S3 — "Title of the page" (example.com, 2026-03-11)
      §Heading > Subheading
      <excerpt text>
```

The identifiers are short labels assigned per request (`E1`…`En`) and mapped back
to `excerpts.id` in a lookup the server holds. The model never sees a UUID and
cannot fabricate a plausible one.

### 8.2 Selection for drafting

Rather than pass every excerpt, the drafting call receives the top `k` excerpts
per outline section by cosine similarity to that section's heading and intent,
deduplicated, capped at a total token budget (default 12k). This is what the
vector index is for in the ordinary case: a 60k-token source pile becomes a
12k-token prompt, which is roughly a 75% reduction on the input side of the most
expensive call in the pipeline.

Every excerpt passed to the model is recorded on the article version, so
"which sources informed this output" has a stored answer rather than a
reconstructed one.

### 8.3 Marker integrity — mechanical, no model

The drafting instruction requires every sentence that asserts a fact, figure,
date, name, quotation or claim about the world to end with one or more markers
`[E12]`. Narrative connective tissue, the introduction's framing and the
call to action carry no marker and must assert nothing.

After generation, deterministically:

1. Extract every `[Ex]` marker from the body.
2. Any marker not in the set supplied to that call is a **hard failure**. The
   call is discarded (logged as `discarded`, with tokens), and retried once with
   the offending identifiers named in the retry prompt. A second failure stops
   the request at `failed`.
3. Build `claim_map`: sentence index → excerpt ids → source ids.

A hallucinated citation cannot reach a reviewer. It is not detected and warned
about; it is structurally impossible to store.

### 8.4 Weak-citation detection — the vector check

Marker integrity proves a citation _exists_. It does not prove the sentence has
anything to do with it. So for every marked sentence, embed the sentence
(`input_type: "query"`) and compute cosine similarity against each excerpt it
cites. The highest similarity is the sentence's grounding score.

- ≥ 0.45 — grounded
- 0.30 to 0.45 — weak, listed in `weak_citations`, highlighted amber in review
- < 0.30 — flagged as unsupported, counts toward the revise threshold

This catches the failure mode that marker integrity cannot: a real citation
attached to a claim it does not support. Embedding twenty sentences costs a
fraction of a cent.

Thresholds are constants in one file, and the test pack (§21) includes a
deliberately mis-cited sentence so the numbers are tuned against a real example
rather than guessed.

### 8.5 The tripwire — unmarked sentences that should not be unmarked

Any sentence with **no** marker that contains a digit, a percentage, a currency
symbol, a four-digit year, a quotation mark, or a capitalised multi-word phrase
that appears in neither the request, the brand voice, nor any selected excerpt,
is flagged as an `unsupported_candidate`.

This is the Week 3 commercial-terms check applied to editorial content: the
model was instructed to cite its claims, and rather than trust the instruction we
measure its outcome. If you can measure whether an instruction was followed,
measure it.

### 8.6 What gets shown

The review screen renders the article with every marked sentence carrying a
superscript that opens the exact excerpt text, the source title and the live URL.
Amber for weak, red for flagged. The reviewer is reading the article and can see,
without leaving it, what each claim rests on.

---

## 9. Planning and angle selection

Input: the idea, audience, keyword, brand voice, and a compact digest of the
selected sources (title, site, one-line summary from the first excerpt, top three
excerpt snippets each). Not the full corpus — planning does not need it.

Output, via structured outputs (`output_config.format`, `json_schema`, strict):
exactly three angles, each with a headline, a 4–7 item outline of H2 sections
with a one-line intent per section, a primary keyword, secondary keywords, the
excerpt ids it would lean on, and a one-sentence rationale.

Constraints checked in code, not asked for politely: the primary keyword must
appear in the headline; each angle must reference at least two distinct sources;
two angles must not share more than 70% of their outline intents (measured by
embedding the outlines and comparing), because three restatements of the same
angle is not a choice.

If the constraint check fails, one retry with the violation named. Second
failure surfaces the three angles anyway with a warning — this is an advisory
quality check, not a correctness gate, and blocking the human here would be
worse than showing them three similar options and letting them decide.

---

## 10. Article generation

**Model: Claude Sonnet 5** (`claude-sonnet-5`). Long-form prose with judgment, one
call per article, the largest single token spend in the pipeline. Opus 5 is 2.5×
the input and output price for work Sonnet 5 does at publication quality. See
§19 for the full argument.

The prompt carries: the chosen angle and outline, the brand voice (tone rules,
banned phrases, reading level, CTA), the SEO rules from
`assets/seo-best-practices.md` as explicit constraints, the selected excerpts
with their labels, and the citation instruction from §8.3.

The SEO rules become checkable constraints rather than aspirations:

| Rule                                   | Enforced as                                                      |
| -------------------------------------- | ---------------------------------------------------------------- |
| Primary keyword in title               | Computed check, case-insensitive, stemmed                        |
| Primary keyword in first 100 words     | Computed check                                                   |
| Exactly one H1                         | Computed check                                                   |
| H2 sections present, H3 where useful   | Computed check on heading tree                                   |
| Paragraphs of 2–3 sentences            | Computed, reported as a distribution, warns above 4              |
| 2–3 relevant links                     | Computed count; every link must resolve to a selected source URL |
| Section depth reflects source strength | Judged, not computed                                             |

Links are the interesting one. A model asked for "2 to 3 relevant external
links" will produce plausible URLs. So links are not generated: the model marks
where a link belongs and which excerpt it should point at, and the server
substitutes that source's real URL. **A link cannot be wrong because the model
never writes one.** This is the same move as rendering Week 3's Pricing section
from the template rather than generating it and checking afterwards: remove the
failure surface instead of policing it.

Output is markdown plus a small JSON header. Because the body must carry
citation markers and free-form prose, the body is not schema-constrained; the
header (title, meta description, keywords, link intents) is a separate strict
structured-outputs call over the finished body, which is cheap and reliable.

Sentence segmentation for the claim map uses `Intl.Segmenter` with
`granularity: 'sentence'`, which is in Node and handles abbreviations and
decimals correctly. A hand-rolled split on `.` would break on "2.5%" and
"Inc." and would corrupt the claim map silently, which is the worst kind of bug
this system can have.

### 10.1 Where the article lives, and what the posts link to

The channel posts need somewhere to point. The brief puts a CMS out of reach and
§22 keeps it there, so **the application hosts the article itself** at
`/a/[slug]`, a public, signed-out, SEO-rendered page with the title, meta
description, body, image with its attribution, and the full source list with
live links.

This solves three problems with one page. The LinkedIn post and the newsletter
have a real `link_url`. The grader has a live link that shows finished work
rather than an empty dashboard. And the source list — the thing the brief asks
the system to make clear — is public, which is the honest place for it.

The permalink is generated from the title, slugified, with a short suffix for
collisions, and is stable once assigned. It renders only for requests that have
reached `content_review` or beyond, and shows a version banner when the article
has been revised since publishing.

---

## 11. Evaluation and revision

### 11.1 The split

`assets/content-evaluation-rubric.md` has nine criteria. They do not all deserve
the same treatment.

**Computed — no model, no opinion:**

| Criterion           | How                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Source Grounding    | Marked-sentence ratio, weak citations, tripwire flags (§8)                                            |
| Factual Consistency | Unsupported candidates, plus number/date agreement between each marked sentence and its cited excerpt |
| SEO Fit             | The checks in §10                                                                                     |
| Channel Fit         | The checks in §12, per channel                                                                        |
| Completeness        | Every outline section present, every requested channel produced, image present if required            |

**Judged — one call, Claude Opus 5:**

| Criterion       | Why a model                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------- |
| Topic Relevance | Does this answer the request                                                                |
| Audience Fit    | Right depth for the stated audience                                                         |
| Tone            | Against the stored brand voice, including banned phrases (banned phrases are also computed) |
| Clarity         | Readable, skimmable, direct                                                                 |

The judge is given the article, the rubric, the brand voice and the computed
results — but **not** the drafting prompt or the model's rationale. It is
evaluating the artefact, not agreeing with the reasoning that produced it.

Output is strict structured JSON: per-criterion score 1–5 with a one-line reason,
a list of sections needing revision with the specific problem in each, and an
overall status.

**A criterion the judge could not assess is `null` with a reason, never a score.**
A null propagates: the overall status cannot be `pass` with a null in it.

### 11.2 The decision

- `reject` if any computed check is a hard failure (marker integrity, banned
  phrase present, missing outline section) or any judged score is 1.
- `revise` if grounding flags exceed the threshold, or any judged score is 2, or
  an SEO check fails.
- `pass` otherwise.

The status is computed from the parts in code. The judge's own overall verdict is
stored and displayed, but it does not decide — a model that returns `pass` while
a computed check is failing is overruled, and the disagreement is logged.

### 11.3 Revision

The reviser receives the current body, **only the sections flagged for
revision**, the specific problem in each, the excerpt set, and the flagged
sentences. It returns replacement markdown for those sections only. The server
splices them into a new `article_versions` row with `origin = 'revision'` and
`parent_version_id` set, then re-runs every check.

Revising sections rather than regenerating the article is cheaper and preserves
what already passed. Two rounds maximum. A third `revise` becomes `needs_human`.

### 11.4 Human revision

At gate two, a reviewer can edit the article directly or request a revision with
a note. A human edit creates a version with `origin = 'human_edit'` and re-runs
the computed checks — **including grounding**. A human is allowed to add an
unmarked factual sentence; the system flags it and shows the flag, and the
reviewer can accept it explicitly. The check does not become optional because a
person did the typing.

---

## 12. Channel adaptation

**Model: Claude Haiku 4.5.** Four short outputs, explicit formatting rules, low
judgment, high volume relative to their length. The rules in
`assets/channel-formatting-rules.md` are specific enough to follow mechanically;
the WhatsApp rules are ours, since the brief does not supply them.

Input for all four: the approved article body with its citation markers, the
brand voice, the channel rules, and nothing else. No excerpts, no web access, no
source corpus. **The adapter physically cannot introduce a claim that is not in
the article.**

Markers are inherited. Any marker appearing in a channel output must appear in
the article's `claim_map`; anything else is a hard failure and a retry. Any
number or date in a channel output that does not appear in the article is
flagged by the same tripwire as §8.5.

### 12.1 Computed format checks

**LinkedIn** — PAS structure present (the output declares its problem,
agitation and solution spans and they are checked for non-overlap and order);
paragraphs ≤ 3 lines; emoji count within the brand voice's allowance; a CTA
present as the final block; ≤ 3000 characters.

**X** — ≤ 280 characters including the link if present, counted the way the
platform counts: any URL weighs 23 characters regardless of its real length, and
most emoji and CJK characters weigh 2. Counting `body.length` in JavaScript will
pass posts the API then rejects, so the counter is a small tested function, not
a property access. Also 1–2 hashtags; at least one line break; exactly one core
idea (the adapter states the idea in a field and it is checked for length, not
semantics).

**Newsletter** — subject line present and ≤ 65 characters; intro of 1–3
sentences; at least two subheadings or a bulleted block; a CTA; a sign-off; body
between 250 and 600 words. Word count outside the band is a hard failure and one
retry with the actual count named, because "between 250 and 600 words" is
checkable and a model told the real number usually fixes it.

**WhatsApp** — ≤ 900 characters, well inside the 4,096 limit, because a broadcast
that needs a "Read more" tap has already lost; a hook in the first line, since
that is all the notification shows; one link, at the end, so the preview renders
against the closing thought; no more than one emoji per paragraph; an explicit
opt-out line, which is both courteous and what keeps a number from being blocked.

WhatsApp does not use markdown. Bold is `*single asterisks*`, italic is
`_underscores_`, strikethrough is `~tildes~`, monospace is triple backticks.
Headings do not exist. So the adapter emits WhatsApp syntax directly and a
converter check asserts that **no `**`, no `#`and no`[text](url)` survives into
the body\*\* — markdown leaking into a WhatsApp message is the single most common
way these integrations look amateur, and it is trivially detectable.

Template messages have their own rules that break sends rather than look bad:
a parameter may not contain a newline, a tab, or more than four consecutive
spaces. The template builder validates every parameter against that before the
API is called, because the API's error for this is opaque and the cause is
invisible in any UI. Print the parameter bytes when it fails.

Every failed check produces a retry with the specific violation and the actual
measured value. One retry per channel. A second failure marks that channel
`format_failed` and surfaces it at gate two — the other channels still proceed.
One broken channel never blocks the others.

### 12.2 What each channel links to

All four link to the article permalink from §10.1, except X, where the link is
optional and off by default. That default is now an editorial decision rather
than a cost one: an X post that earns a click on its own hook outperforms one
that spends its first line asking for it. The toggle remains, and the reason
shown next to it changed when the publishing route did.

---

## 13. Images

One image per request, optional, attached to the article and available to the
LinkedIn post.

Search an openly licensed library (Openverse) with a query derived from the
article title and primary keyword. Take the top few candidates, store
`licence`, `licence_url`, `attribution_text` and `source_page_url` for each.
A candidate missing licence metadata is discarded, not defaulted.

The reviewer picks one at gate two, or none. Alt text is generated by Haiku from
the article title and the image's own description, capped at 125 characters,
and checked for that cap.

The chosen image is downloaded to Supabase Storage so the published content does
not depend on a third party's hotlink staying alive. Attribution travels with it
into the newsletter and the LinkedIn post.

**No image generation.** A synthesised image on an article whose entire design
premise is verifiable sourcing would undercut the thing the system is for.

---

## 14. Review and approval

### 14.1 Gate one — sources and angle

One screen, two steps.

Sources first: a list with title, site, published date, relevance score, a
one-line summary, and a checkbox. Failed fetches appear below with their status
and reason, uncheckable. The reviewer unchecks anything they do not want and
presses **Use these N sources**, which generates the angles inline.

Angles second: three cards, each with headline, outline, keyword, and the sources
it draws on. Pick one, or **Re-plan** with a note. Every re-plan costs money and
the button shows the amount; after two, the third asks for confirmation and says
what has been spent on planning so far.

Excluding a source after angles exist invalidates any angle that used it. The
affected cards grey out with the reason and re-planning is offered. It does not
silently continue with an angle whose foundation was just removed.

### 14.2 Gate two — content

Left: the article, rendered, with citation superscripts and the amber/red
highlighting from §8.6. Right: a tabbed panel with the evaluation report,
the four channel outputs, the image candidates, the source list, and the version
history. Each channel tab carries its own format-check result and, for the two
handoff channels, a note naming who will post it.

The evaluation report leads with computed results, because those are facts, and
then the judged scores. Every flagged claim is a link that scrolls the article
to that sentence.

Actions: **Approve** per channel (channels are approved independently),
**Approve all** for the ordinary case, **Request revision** with a note,
**Edit** the article directly, **Reject** the request. Approving at least one
channel moves the request to scheduling.

**One column, decision first.** Gate two was a side-by-side split giving the
ARTICLE the larger half: 1,243 words the reviewer had already approved, and
which they cannot even edit once a channel is approved, taking more of the
screen than the decision they came to make. Both halves scrolled independently,
so the panel became a letterbox inside an already short card.

The order is now what-needs-you, then the decision panel at full width, then the
article behind a disclosure, open while it is still editable and collapsed once
it is not. The activity log stays at the bottom but shows its most recent entry
in the summary, because a collapsed log under a long article is a log nobody
knows exists.

**The screen is composed, not monolithic.** `gate-two.tsx` orchestrates and
owns the article; each panel is its own module under `components/review/`
calling its own server actions with its own pending and error state. The single
858-line version threaded shared state through every panel, which is how
approving one channel came to spin every button on the screen and how one
`readOnly` flag came to answer two unrelated questions. A panel receives the
facts it reads (`holdInQueue`, `publishTarget`), never the whole request.

**Approving one channel must never close the others.** Approval moves the
request to `scheduled`, and gate two derived a single read-only flag from that
status — so approving LinkedIn removed the approve button from a newsletter that
was still a draft. The server always allowed it; the UI locked itself. Two
separate questions, answered separately (`isArticleLocked`,
`areChannelsLocked`): the ARTICLE closes once anything is approved from it,
because the approved channel versions were derived from that text, while the
CHANNELS stay decidable until the request is published or cancelled. The screen
leads with the outstanding decision rather than leaving a reviewer to count
status pills across two panes.

"Independently" is about the guarantees, not the number of clicks. Approve-all
calls the same single-channel path per channel, so each still gets its own
approval row, its own queue row and its own NOT NULL columns; partial success is
reported honestly rather than rolled back, because an approval that really
happened is not undone by a later one failing. Only clean drafts are included —
a `format_failed` channel needs a written note saying why it is going out
anyway, which is a deliberate per-channel decision.

**Approved work is never invisible.** A held item is a ROW, not a skipped
insert. `publish_queue.scheduled_for` was NOT NULL, so "approved, no send time
decided" had no representation; the approval action handled that by skipping the
insert and logging "held in the queue" about a row it never created. The channel
read `approved`, the request moved to `scheduled`, and the queue was empty — the
item appeared on no screen in the product. `held` now names that state, with a
null send time and a check constraint keeping the two consistent. The release
worker claims only `queued` rows with a due time, so a held item is visible and
deliberately not due.

### 14.3 Publishing is not possible before approval

Enforced in three places, because the UI is not a security boundary:

1. `publish_queue` rows are only created by the approval action.
2. The publish worker refuses any row whose `channel_output.status != 'approved'`
   or whose `approvals` row is missing, and logs the refusal.
3. `publish_queue.approved_by` and `approved_at` are `not null`, so a row cannot
   be inserted at all without an approval to point at. This one survives a later
   refactor of the other two.

---

## 15. Publishing

### 15.1 Connectors

Two kinds, and the worker branches on `connectors.kind`, never on a channel name.

| Channel    | Kind         | Mechanism                                                                                                                      |
| ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Newsletter | `delivering` | Resend, to opted-in recipients. `DEMO_MODE` redirects every send to one address and the UI shows the real intended recipients. |
| WhatsApp   | `delivering` | WhatsApp Business Cloud API, to opted-in recipients. See §15.3.                                                                |
| LinkedIn   | `handoff`    | Copy-ready packet dispatched to the poster at the scheduled time; they confirm with a URL.                                     |
| X          | `handoff`    | Same.                                                                                                                          |

**A connector is a row, and its absence is a state.** The publish worker reads
`connectors` before it reads the queue. A **delivering** channel whose connector
is `not_connected`, `expired` or `revoked` puts its queued items into
`blocked_not_connected` with the reason, and the dashboard shows a banner. The
items stay queued and go out when the connector is restored. The system never
renders "published" for something that did not happen — an honest blocked state is
worth more than a fake success, and a fake success is precisely the failure mode
this program grades against.

**A handoff channel is never blocked for want of a connection**, because it has
no account to connect: a person posts it, and the system only has to email them
the packet. The check ran before the `kind` branch and therefore blocked every
LinkedIn and X item on a credential §2.11 deliberately does not require —
nothing ever dispatched, and the queue reported two of three channels "not
ready" when nothing was wrong with either. The rule lives in
`needsConnectedAccount` (`src/lib/publish/gate.ts`), pure and tested, because
this was a silent failure no type could catch. What a handoff actually needs is
an assigned poster, checked at dispatch where the address matters.

Token refresh runs before each send when `expires_at` is within ten minutes. A
refresh failure sets `expired` and blocks rather than attempting a call that will 401.

**Why LinkedIn and X are handoff, written down where the build can see it.** X
has had no free tier since February 2026 and charges per post. LinkedIn's
self-service scope needs a verified app backed by a Page, posts only as one
individual, and offers no read-back to reconcile an uncertain send. Neither
credential was supplied with the brief. Generating and grading their content is
in scope and unchanged; posting on the agency's behalf is not something this
build can do honestly, so it does not claim to. §2.11 carries the full argument.

### 15.2 The release worker

A Vercel Cron route (`/api/cron/release`, every five minutes) authenticated by a
shared secret header compared with `timingSafeEqual`. It claims due items one at
a time:

```sql
UPDATE publish_queue q
   SET status = 'publishing', attempt = attempt + 1, reserved_at = now()
 WHERE q.id = (
   SELECT id FROM publish_queue
    WHERE status = 'queued' AND scheduled_for <= now()
    ORDER BY scheduled_for
    FOR UPDATE SKIP LOCKED
    LIMIT 1)
RETURNING *;
```

**Reserve, then act, then confirm.** One statement moves the row out of
`queued`, so two overlapping cron invocations cannot both claim it.
Read-then-write would lose that race and send twice, which on a WhatsApp
broadcast means every recipient's phone buzzes twice with the same message. There
is no unsending it.

Maximum ten items per invocation, then it returns and waits for the next tick.

### 15.3 Delivering a fan-out item: WhatsApp and the newsletter

Both channels send to many recipients, so the unit of work is a recipient, not a
queue row.

1. Check the connector; refresh the token if needed.
2. Load opted-in recipients for the channel. Anyone without `opted_in_at`, or
   with `opt_out_at` set, is written as `skipped_no_optin` and never contacted.
3. For each recipient with no `publish_deliveries` row in `sent` or `delivered`,
   send, then write the row with the provider's message id. **The delivery row is
   the idempotency record.** A retry after a partial failure re-sends only to the
   rows that are not yet `sent`.
4. When every recipient is terminal: all sent → `published`; some sent →
   `partially_delivered`; none sent → `failed`. The count is displayed as
   "37 of 40 delivered, 3 failed", never as a status word on its own.

**WhatsApp's window and template rules are a correctness problem, not a pricing
footnote.** Meta bills per message since July 2025. A non-template message may
only be sent inside a customer-initiated 24-hour service window, and inside that
window it is free. Outside it, a business-initiated message must use an approved
template, and a marketing template is charged at the recipient's country rate —
Nigeria falls under the Rest of Africa card.

So the adapter produces both forms, and the sender decides per recipient:

- `last_service_window_opened_at` within 24 hours → send the free-form body, free.
- Otherwise → send the approved marketing template with the body as parameters,
  and record the cost.
- No approved template available → the item is **blocked with that reason**, not
  attempted. Firing a free-form broadcast at a closed window returns an opaque
  API error, and a system that discovers its own rules from error codes at
  send time is a system that will do it in front of a client.

Recipient phone numbers are stored in E.164 and validated before insert. An
invalid number is rejected at import with the row number, not at send time.

### 15.4 Dispatching a handoff item: LinkedIn and X

At the scheduled moment the system does not post. It assembles a packet — the
approved body, the image with its attribution, the article permalink, the
character count, and a signed one-time confirmation link — and delivers it to the
assigned poster over WhatsApp, falling back to email.

The item moves to `awaiting_manual_post`. The confirmation link opens a small page
with the post text ready to copy, the image to download, and one field: the URL of
the post once made. Submitting it sets `posted_manually` with `platform_url` and
the actor, and writes `activity_log`.

An item still `awaiting_manual_post` two hours after its scheduled time re-notifies
once, and then appears in the Failures strip. Scheduled work that quietly never
happened is the failure the Week 1 feedback was about, and it does not become
acceptable because the last step was a person's.

The confirmation link is a signed token with an expiry, scoped to one queue row.
It is not a guessable id, because that link is the one URL in this system a
stranger could act on.

### 15.5 `uncertain`, and the watchdog

A timeout means the message may or may not have gone. Retrying is how one
recipient gets the same broadcast twice.

A watchdog in the same cron run moves any row in `publishing` for more than five
minutes to `uncertain`, and any `publish_deliveries` row stuck in `pending` the
same way. For each, a reconciliation attempt reads the provider's status by
message id. Found means the row resolves. Not found means it is offered to a
human with **It sent / It did not** and the actual content, and only a person
moves it.

**This applies per recipient, not only per queue row.** The sweep originally
marked a stuck delivery `failed`, and the worker re-sends anything that is not
`sent` or `delivered` — so a delivery that timed out, and may well have
arrived, was re-sent and that subscriber received the newsletter twice. That is
the exact failure rule 9b exists to prevent, and it contradicted the paragraph
above it.

`publish_deliveries.status` therefore has its own `uncertain` value, distinct
from `failed`:

| Status      | Means                                      | Retried? |
| ----------- | ------------------------------------------ | -------- |
| `failed`    | The provider refused it. It did not go.    | Yes — safe, we know the outcome |
| `uncertain` | The provider never responded.              | **No** — it may already have arrived |

An `uncertain` delivery is counted separately in the roll-up, so a queue row is
never called `partially_delivered` on the strength of sends nobody can account
for. The message says what is true: "37 of 40 delivered, 2 failed, 1 unknown".
Those rows surface in the dashboard and the queue with the recipient and the
provider message id, which is what a person needs to resolve one by hand.

| Channel     | Read-back                                       | Consequence                                                       |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| WhatsApp    | Message status by id, plus delivery webhooks    | Reconciles automatically                                          |
| Newsletter  | Resend message id and status by id              | Reconciles automatically                                          |
| LinkedIn, X | Not applicable — nothing was sent by the system | A missed handoff is a notification problem, not an uncertain send |

An automated system that cannot tell whether it did something must ask, not
guess.

**Webhooks.** WhatsApp delivery and read receipts arrive asynchronously.
The webhook endpoint verifies Meta's signature, is idempotent on the provider
message id, and updates `publish_deliveries` to `delivered`. A webhook for a row
we do not recognise is logged and dropped, never used to create a row.

### 15.6 Notification

A terminal failure, a `blocked_not_connected` item, an `uncertain` row, a
`partially_delivered` broadcast, or a handoff still unposted two hours after its
slot notifies the request's creator — over WhatsApp where a number is on file,
email otherwise — and appears in the dashboard's Failures strip. This is the
direct answer to the Week 1 diagnostic: an important failure does not sit
unnoticed, because someone is told, on the channel they actually read.

---

## 16. Interface

**Understandable in five seconds, readable after that.** Week 2's feedback was
that a founder had to read too much before understanding the state of things.
The fix is not more prose written better; it is less prose.

### 16.0 Visual system

Calibrated against the tools this kind of product is measured by — Vercel,
Linear, Supabase — which share a specific discipline rather than a look:

- **A 4px grid**, with nothing between the steps.
- **Hairline borders carry structure; shadows are reserved for things that
  genuinely float.** A shadow on every card is what made the first version read
  as dated: if everything is elevated, elevation means nothing.
- **14px body, 13px secondary, 12px meta.** Denser than a marketing page,
  because a manager scanning twelve requests wants more on screen, not less.
- **Tight tracking on headings, normal on reading text.** Compression reads as
  engineered at display sizes and as cramped at reading sizes. Article body is
  15.5px at 1.72 line-height and capped at 68ch, which is a reading measure
  rather than an interface one.
- **Tabular figures** anywhere a number updates in place, so counts and costs
  do not jitter as they change.
- **One accent colour.** Colour means status in this system, so spending it on
  decoration leaves nothing to say "this failed" with.
- **Dark mode is a first-class palette**, defined token by token rather than
  derived by inversion, because these are tools people keep open all day.

### 16.0.1 What the interface must never ask a person to do

Anything with an exact mechanical answer is computed, not delegated. An X post
handed back with "cut at least 46 characters" is the system asking a founder to
do arithmetic it could do perfectly; it is trimmed at a sentence boundary
instead, and marked as trimmed so the edit is visible. Judgment calls still go
to a person, and the distinction is whether the answer is computable, not
whether it is inconvenient.

Evidence is shown whole. A flagged claim truncated mid-word cannot be checked,
which defeats the purpose of flagging it. Recommendations are a list of discrete
actions rather than a paragraph, capped in the schema.

**Dashboard.** A row of tiles first: _Needs you_ · _Scheduled today_ ·
_Failed or blocked_ · _Spent this month_. Each is a number and a label, each
links to a filtered list. Below, request cards: status pill, headline or idea,
channel chips coloured by their individual state, the next action as a button,
and the age. Failed and blocked sort above everything. Nothing on this screen
requires reading a paragraph to know what is going on.

**Request detail.** The pipeline as a horizontal stepper with the current step
lit, the cost so far against the budget, and the step-appropriate workspace
below.

**Queue.** Grouped by scheduled time, with connector status banners at the top
and per-item cost. A WhatsApp broadcast shows its recipient count and, once sent,
its delivered-of-total. A handoff item shows who it went to and whether they have
confirmed. `uncertain` items pin to the top in red with their two
buttons.

**Recycle bin.** Deleting a request sets `deleted_at` rather than removing the
row. A hard delete cascaded to `model_calls` and took the costs with it, so
clearing out a few drafts made "Spent this month" read $0 for money that had
genuinely been spent — a cost report a delete can rewrite is not a report. The
bin lists what was deleted with its cost, and restores in one click.

Permanent deletion is available from the bin and rolls the spend into
`retained_spend` first: a standalone ledger, keyed by month, with no foreign key
to anything, so there is no row whose removal can take it away. The dashboard's
monthly total is live spend plus retained spend, and it filters deleted requests
out of the work counts but never out of the money.

Empty states say what is missing and what to do, never a bare zero. A tile
reading "0 failed" when the failure count could not be loaded is a lie, so the
tile reads "—" with a tooltip instead.

---

## 17. Failure handling

Every step is wrapped so that a thrown error produces: a `failed` status naming
the step, a plain-language `failure_reason` and a structured `failure_detail`, an
`activity_log` row at `error`, and an email if terminal.

**Partial success is its own outcome.** Four of six sources fetched; two of three
channels formatted; one of three publishes succeeded. Each of these is recorded
as what it is. The Week 2 lesson applies: continue-on-failure that swallows the
diagnostic is half a job — the run continues, and the failure is still loud
somewhere.

**Retry is offered only where retrying could help.** A 404 source, a rejected
draft that failed marker integrity twice, a 400 from a platform — no retry
button. A 429, a 5xx, an embedding failure, a timed-out fetch — retry button,
and it resumes from the failed step rather than from the beginning.

**And an automatic retry must be real.** `POST /api/runner` returns `more`,
which is what tells the client poller to call again; the poller is the only
thing performing automatic retries while someone is watching. Returning
`more: false` on a retryable failure while logging "trying again" means the
retry never happens and the request sits behind a spinner indefinitely — worse
than an error, because an error can be acted on. `more` therefore means "a
retry is coming", decided by one exported predicate (`willRetryAfterFailure`)
that both the runner and the UI read, and the attempt count is shown to the
person watching rather than only written to the log.

A retry is also only honest if the failure could succeed later. A budget
refusal cannot: the next attempt costs the same and the money is just as
absent. `BudgetExceededError` must reach the runner intact — a step that
catches it, retries it once, and flattens it into a generic message turns a
terminal condition into four wasted attempts and tells the manager that
"retrying usually clears it". Terminal failures name what they need and who can
supply it.

**Unknown is not zero.** Stated once, applied at every layer where Week 2 proved
it has to be applied separately:

| Layer                | Unknown looks like                                                         |
| -------------------- | -------------------------------------------------------------------------- |
| Source               | `fetch_failed` / `empty` / `paywalled`, distinct, with reason              |
| Excerpt              | A source with no embeddable chunks is marked, not absent                   |
| Evaluation criterion | `null` with a reason, never a score of 0                                   |
| Evaluation run       | `not_evaluated`, which cannot become `pass`                                |
| Article              | A missing outline section is a Completeness failure, not a shorter article |
| Send                 | `uncertain`, which is not `published` and not `failed`                     |
| Broadcast            | `partially_delivered` with real counts, never a bare status word           |
| Recipient            | `skipped_no_optin` is counted and shown, not a smaller audience            |
| Handoff              | `awaiting_manual_post` is not `published`, however long it sits            |
| Cost                 | `cost_complete = false` renders "at least $X"                              |
| Dashboard tile       | "—", never "0", when the count could not be read                           |

---

## 18. Cost model and model selection

### 18.1 Prices used

| Model              | Input     | Output     |
| ------------------ | --------- | ---------- |
| `claude-opus-5`    | $5 / MTok | $25 / MTok |
| `claude-sonnet-5`  | $2 / MTok | $10 / MTok |
| `claude-haiku-4-5` | $1 / MTok | $5 / MTok  |

`web_search` $10 per 1,000 searches. `web_fetch` free beyond tokens.
OpenAI `text-embedding-3-small` roughly $0.02 / MTok. Firecrawl per credit per scrape.

Delivery:

- **Newsletter** — Resend, free at this volume.
- **WhatsApp** — free inside a customer-initiated 24-hour service window and on
  the developer test number; a marketing template outside a window is charged per
  message at the recipient's country rate, Nigeria under Rest of Africa. The
  system prices a broadcast per recipient before sending and shows the total.
- **LinkedIn, X** — no platform cost, because the system does not post to them.
  The cost avoided is real and belongs in the reflections: at $0.015 a post and
  $0.200 for one carrying a link, X alone would have been the second largest
  line item in this pipeline after drafting.

Prices live in one constants file with a `PRICES_VERIFIED_ON` date, because they
change and a stale price is a wrong cost report.

### 18.2 Assignment, and the reasoning

| Step                         | Model                    | Why                                                                              |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Query planning and discovery | Haiku 4.5 + `web_search` | Query formulation is light judgment; the search tool does the work.              |
| Chunking                     | **none**                 | A splitter does this. A model call here is money spent on nothing.               |
| Relevance ranking            | **none** (vectors)       | Cosine similarity, not a model.                                                  |
| Angle planning               | Haiku 4.5                | Short, schema-constrained, three options from a digest.                          |
| Article drafting             | **Sonnet 5**             | Publication-quality long-form prose with real judgment. The largest token spend. |
| Evaluation                   | **Opus 5**               | See below.                                                                       |
| Revision                     | Sonnet 5                 | Same class of work as drafting, on a smaller span.                               |
| Channel adaptation           | Haiku 4.5                | Explicit rules, short outputs, low judgment.                                     |
| Alt text                     | Haiku 4.5                | One sentence from a title.                                                       |

**The inversion worth explaining.** The obvious assignment is the strongest model
for writing and a cheaper one for grading. This design does the opposite, and the
arithmetic is why. A 1,500-word article is roughly 2,200 output tokens on a
drafting call carrying about 14k input tokens. On Sonnet 5 that is about 2.8
cents in and 2.2 cents out. The evaluation call carries the same article as
_input_ — about 3k tokens — and returns perhaps 800 tokens of structured
verdict. On Opus 5 that is 1.5 cents in and 2 cents out. **Judging costs about a
third of what writing costs**, because the judge reads one article and writes a
paragraph while the writer reads a corpus and writes an article.

Given that, the question is where an extra cent buys more. It buys more at the
gate. A better writer produces prose a human would have edited anyway; a better
judge is what stops a weak draft from reaching a human at all, and the judged
criteria — audience fit, tone against a stored voice, clarity — are exactly the
ones that reward judgment. Opus 5 for evaluation and Sonnet 5 for drafting costs
roughly two cents more per article than the conventional arrangement and puts
the stronger model where a mistake is most expensive.

The alternative considered and rejected: Opus 5 for both. That roughly doubles
the drafting cost for prose quality that Sonnet 5 already delivers at
publication standard, on the step with the largest token volume in the system.
It is the single easiest way to triple the running cost of this pipeline without
improving what a reader sees.

Every assignment is per task, not per project, and every call records
`model_used` so the assumption can be checked against real spend rather than
argued about.

### 18.3 Estimated cost of one full request

| Step                         | Estimate   |
| ---------------------------- | ---------- |
| Search (1 call, ≤4 searches) | $0.04      |
| Firecrawl (6 scrapes)        | ~$0.01     |
| Embeddings (60k tokens)      | ~$0.001    |
| Angle planning               | ~$0.01     |
| Drafting                     | ~$0.05     |
| Evaluation                   | ~$0.035    |
| One revision round           | ~$0.03     |
| Channel adaptation (3)       | ~$0.01     |
| **Total**                    | **~$0.19** |

Plus delivery: zero on the demo path, since the newsletter is free at this volume
and WhatsApp is free to the test number's allowlist. A production WhatsApp
broadcast is the only line that scales with audience size, and it is priced per
recipient and shown before the send. Default budget of 150 cents leaves room for
two revision rounds and a re-plan, and stops well before anything alarming.

The four-channel adaptation step is four Haiku calls of a few hundred output
tokens each. Adding WhatsApp cost roughly a third of a cent.

### 18.4 Spending controls

- Per-request budget, checked before every model call — against the call's
  **worst case**, priced from the assembled input tokens plus `max_tokens` at
  the output rate, not against what it turns out to cost afterwards. Checking
  after the fact is not a budget, it is a receipt. Crossing it stops the request
  at `budget_exceeded` with everything produced so far intact.
- Monthly global cap in `usage_counters`. At the cap, new requests are refused
  with a clear message; in-flight requests finish.
- Per-account and per-IP rate limits on request creation, counted in Postgres
  with an atomic upsert. **Fails closed**: if the counter cannot be read, the
  request is refused. A public demo with a sign-in button is a public spend
  button.
- Prompt caching on the brand voice, the rubric and the SEO rules, which are
  identical across calls.
- Firecrawl `maxAge` reuse, and `content_hash` to skip re-embedding a page whose
  content has not changed since a previous request.

---

## 19. Security

1. **No key reaches the browser.** Anthropic, Firecrawl, OpenAI, Resend,
   Supabase service role and WhatsApp credentials are read server-side only,
   in route handlers and server actions. No `NEXT_PUBLIC_` key is a secret.
2. **Connector tokens are encrypted at rest** with AES-256-GCM, key from
   `TOKEN_ENCRYPTION_KEY`. Decryption happens only inside the publish path.
   They are never selected into a payload that crosses to a client component.
3. **`.gitignore` before the first commit.** `.env*` never enters the repository.
   A secret in git history is a leaked secret regardless of the current file.
   `.env.example` carries names and no values.
4. **RLS on every table.** Reads scoped to the authenticated profile and its
   role; writes to the publish queue, connectors and model call log only through
   server actions using the service role. The one deliberately public read is
   the article permalink in §10.1, served by a route that selects an explicit
   column list — never `select *`, which is how an internal note or a token
   column ends up on a public page after a later migration.

4b. **RLS is not the only boundary: EXECUTE is one too.** Postgres grants
   EXECUTE to PUBLIC by default on every function it creates, so an explicit
   `grant execute … to service_role` *adds* a grant without removing the
   default. The `public.*` RPC wrappers delegate to SECURITY DEFINER functions
   that bypass RLS, and PostgREST serves `public` — so for a period, anyone
   holding the anon key that ships in the browser bundle could call them.

   Verified against the live project before it was fixed:
   `claim_due_publish_item` returned HTTP 200 to the anon key, letting a
   stranger drag every scheduled item into `publishing` where the watchdog then
   marks it `uncertain` and it stops going out; `bump_counter` let them exhaust
   the rate limits; `add_request_cost` let them push live requests into
   `budget_exceeded`. All three now return 401.

   Migration 0007 revokes EXECUTE from `public`, `anon` and `authenticated` in
   both schemas, sets `alter default privileges … revoke execute` so a function
   added later is not silently open, and re-grants only what is named:
   everything to `service_role`, `read_counter` and `dashboard_counts` to
   `authenticated`, and the three RLS helper predicates to `anon` because the
   policies in §19.4 call them as the querying role.

   `npm run verify:grants` is a standing check, not a one-time audit — the
   default privilege is what caused this, so the only durable fix is one that
   fails the build when it recurs.

5. **Cron is authenticated** with a shared secret compared in constant time.
   An unauthenticated publish endpoint is a stranger's message to your audience.
   The WhatsApp webhook verifies Meta's signature on every call, and the handoff
   confirmation link is a signed, expiring, single-row token rather than an id.

5b. **Recipients are people, and their contact details are the most sensitive
data in this system.** Phone numbers and email addresses are never rendered
into a public page, never written to `activity_log`, and never included in a
screenshot or the demo video. Opt-in is enforced in the send path, opt-out is
honoured immediately and permanently, and every WhatsApp message carries an
opt-out line. The seeded demo list is numbers and addresses we control. An
automation that can message forty people is an automation that can annoy forty
people, and the consent record is what separates the two. 6. **`DEMO_MODE=true`** redirects every newsletter send to one address and
labels social publishes as dry-run, returning a synthetic id clearly marked
as such — and a dry-run publish is stored as `published (dry run)`, a
distinct value, never as a real publish. 7. **Nothing sensitive in the demo data.** The seeded recipient list is fake
addresses on a domain we control. Screenshots and video are checked for keys
and for the connected account's private details before they are shared. 8. **Log redaction.** `activity_log.detail` passes through a redactor that strips
anything matching a token, bearer or key pattern before insert.

---

## 20. Interface to the outside: what must keep working

The live link is graded. A dead link is an unmarked submission.

- The app must load for a signed-out visitor on a machine that is not ours. The
  landing page renders a read-only sample request with real stored output, no
  account required.
- One-click demo sign-in exists, is rate limited per IP, and lands in a
  demo workspace whose budget is capped separately.
- A connector being disconnected must degrade the app, not break it. Every
  screen must render with `connectors` empty.
- Health check at `/api/health` returning the status of Postgres, Anthropic,
  Firecrawl and each connector, so a dead dependency is diagnosable without
  reading logs.

---

## 21. Test plan

The eight scenarios from the brief, plus what each one is really testing.

| #   | Scenario                      | The real test                             | Pass condition                                                                                           |
| --- | ----------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Raw idea request              | Discovery works with no seed URLs         | ≥3 sources fetched, 3 distinct angles, article drafted                                                   |
| 2   | URL-based request             | Seed material is used, not decorated with | ≥60% of marked sentences cite a seed source; no search call made                                         |
| 3   | Research and source grounding | Citations are real and relevant           | Every marker resolves; weak citations listed; source list rendered                                       |
| 4   | Evaluation and revision loop  | Weak drafts improve and history survives  | A seeded weak draft scores `revise`, revision raises the failing criterion, both versions stored         |
| 5   | Human approval                | Publishing is impossible before approval  | Direct API call to publish an unapproved item is refused and logged                                      |
| 6   | Channel formatting            | Rules are enforced, not suggested         | X ≤280 with shortened URL; newsletter within 250–600; LinkedIn PAS present; WhatsApp carries no markdown |
| 7   | Publishing or scheduling      | Safe to run twice                         | Cron fired twice concurrently publishes exactly once                                                     |
| 8   | Failure handling              | Failures are visible and specific         | Each injected failure produces a named state, a readable reason and a notification                       |

### 21.1 The deliberately broken input pack

Built and run **before** the happy path, while there is still time to fix what it
finds.

| Input                                                      | What it should do                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| A 404 URL                                                  | `fetch_failed`, request continues on remaining sources                  |
| A hard-paywalled article                                   | `paywalled`, visible at gate one, excluded from drafting                |
| A PDF link                                                 | `unsupported_type` or parsed, either way not a crash                    |
| A page that is a nav shell with no article                 | `empty`, distinct from `fetch_failed`                                   |
| A URL that redirects to a different domain                 | `redirected_offsite`, kept and flagged                                  |
| The same article at two URLs with tracking params          | One source after canonicalisation                                       |
| An idea so niche search returns nothing                    | `no_sources_found`, not an ungrounded article                           |
| An idea that is pure promotion with no factual content     | Tripwire quiet, grounding ratio low, evaluator flags Source Grounding   |
| A draft with a citation marker for a non-existent excerpt  | Hard fail, retry, second fail stops the request                         |
| A draft citing a real excerpt for an unrelated claim       | Caught by the vector check, not by the marker check                     |
| A 3,000-character LinkedIn post                            | Format failure, one retry, then `format_failed` on that channel only    |
| An X post that goes over 280 only once the link is counted | Caught by the 23-character URL rule                                     |
| A WhatsApp body with `**bold**` left in it                 | Converter check fails, retry, markdown never reaches a recipient        |
| A template parameter containing a newline                  | Rejected before the API call, with the offending bytes printed          |
| A broadcast where recipient 12 of 40 fails                 | `partially_delivered`, 39 delivery rows intact, retry re-sends to one   |
| The same broadcast retried after a partial failure         | Nobody receives it twice                                                |
| A recipient with no `opted_in_at`                          | `skipped_no_optin`, counted and shown, never messaged                   |
| A recipient who opted out between approval and send        | Skipped at send time, not at approval time                              |
| WhatsApp service window expired, no approved template      | Blocked with that reason, not attempted                                 |
| Publish with the connector revoked mid-flight              | `blocked_not_connected`, item stays queued, banner shown                |
| Send that times out                                        | `uncertain`, no retry, read-back reconciliation, human prompt           |
| A delivery webhook for an unknown message id               | Logged and dropped, never creates a row                                 |
| A handoff still unposted two hours after its slot          | Re-notified once, then in the Failures strip                            |
| The handoff confirmation link opened twice                 | Second open shows the recorded URL, does not create a second record     |
| Two cron invocations firing at once                        | Exactly one post                                                        |
| A request submitted twice by double-click                  | One request, enforced by `submit_token`                                 |
| Two runners claiming the same request                      | One advances, the other is a no-op                                      |
| A runner killed mid-step                                   | Lease expires, next runner resumes from stored state, no duplicate work |
| A step failing three times                                 | Request stops at `failed` naming the step, not an infinite schedule     |
| A budget set below the drafting estimate                   | `budget_exceeded` before the call, not after                            |

### 21.2 Evidence discipline

Screenshots are captured while testing, not reconstructed afterwards. Rows where
something failed first are marked **Fixed** with what changed, because the brief
says explicitly that the fix is the interesting part and a table of clean passes
reads like nothing was tested.

---

## 22. Out of scope, on purpose

Named here so they read as decisions rather than omissions.

- **Programmatic posting to LinkedIn and X.** §2.11. Both are generated,
  format-checked, approved and scheduled; both are handed to a person to post.
  Organisation-page posting on LinkedIn additionally needs partner review that
  will not be granted inside a week.
- **Analytics on published posts.** The brief does not ask for engagement data,
  and reading it back costs money on the platforms that have it.
- **Inbound WhatsApp conversation handling.** The system broadcasts; it does not
  run a chatbot. An incoming message opens a service window and is logged, and
  nothing replies to it.
- **Multi-tenant agencies.** One agency, one brand voice set, roles within it.
- **A CMS integration.** The article is exported as markdown and HTML; where it
  is eventually hosted is the agency's decision.
- **Image generation.** §13.
- **Automatic republishing or evergreen recycling.** A scheduling feature that
  reposts without a human is the opposite of this system's premise.
- **Translation or localisation.** One language.

---

## 23. Deployment constraints to settle before building

These are external facts that shape the build and that must be confirmed on day
one, not discovered on submission day.

1. **Vercel cron frequency is plan-dependent. SETTLED: GitHub Actions.**
   A five-minute release cadence needs a paid plan; Hobby allows one run a day
   and rejects a `*/5` schedule outright. `vercel.json` therefore carries NO
   `crons` block, and `.github/workflows/release.yml` drives
   `/api/cron/release` every five minutes with the same shared secret.

   Two things this does not rely on. The in-process scheduler
   (`lib/publish/scheduler.ts`) keeps time on a long-running server, but a
   serverless platform tears the process down between requests, so it fires
   only when something has happened to keep a instance warm. And the queue page
   drains what is due while it is open, which helps nobody at 03:00. Neither is
   a scheduler on Vercel; the workflow is.

   The same endpoint also advances one in-flight request per call, so the
   workflow covers research as well as publishing.

   On a Pro plan, restore the `crons` block and delete the workflow. Running
   both is harmless: the atomic claim (§15.2) means two schedulers racing is a
   normal outcome, not a double send.
2. **Function duration limits** set how much each runner step may attempt. The
   fetch step's batch size (§3.1, four URLs) is derived from this and should be
   tuned once the real limit is known.
3. **WhatsApp Cloud API setup is the one real prerequisite.** Adding the WhatsApp
   product to a Meta app creates a free test business number automatically. Up to
   five recipient numbers can be added to its allowlist, and messages to them cost
   nothing. That is the demo path and it needs no business verification, no
   payment method and no review. Add your own number and two others before
   building anything, because the allowlist is where a demo dies.
4. **A marketing template needs approval before it can be used**, and approval is
   not instant. Submit one on day one — generic, parameterised, reusable — so the
   outside-the-window path can be demonstrated rather than described. The
   inside-the-window path needs no template and no approval.
5. **Firecrawl and embedding free tiers** should be confirmed against the
   expected volume in §18.3 before either is assumed free. **Settled, the hard
   way:** Voyage's free tier allows only a few requests a minute, and the limit
   did not announce itself — it refused six fetched articles of 20k–36k
   characters, which left two usable sources and surfaced three steps later as
   "the angles are too similar". The provider is now OpenAI
   `text-embedding-3-small` at the same $0.02/MTok. A free tier is not a cheaper
   version of a paid tier; it is a different failure mode, and it fails inside
   the pipeline rather than at the door.
6. **Nothing here needs X or LinkedIn credentials.** That is the point of §2.11,
   and it removes the two prerequisites most likely to have eaten a day.

---

## 24. Open questions to resolve during the build

1. Whether Openverse result quality is good enough to be worth the screen space,
   or whether image selection should fall back to "upload one".
2. The exact weak-citation thresholds in §8.4, which must be tuned against the
   broken input pack rather than guessed.
3. Whether one search call with `max_uses: 4` finds better material than two
   calls with narrower queries, measured on three real ideas.
