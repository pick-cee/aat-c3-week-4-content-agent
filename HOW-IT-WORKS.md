# How this works, and how to use it

One page. For the full specification see `DESIGN.md`; for the brief, `PRD.md`.

---

## What it does

A content manager submits an idea, a URL, or both. The system:

1. **Researches** — finds material with Claude's `web_search`, reads every page
   through Firecrawl, chunks it, embeds it and ranks it against the request.
2. **Stops for you** — you confirm which sources to use and pick one of three
   proposed angles.
3. **Writes** — drafts an SEO article using only the stored excerpts, with a
   citation marker on every factual sentence.
4. **Grades its own work** — measures grounding, SEO and completeness in code,
   then has a model judge relevance, audience fit, tone and clarity.
5. **Revises** — rewrites only the sections that failed, up to twice.
6. **Adapts** — produces a LinkedIn post, an X post and an email newsletter,
   each format-checked against the platform rules.
7. **Stops for you again** — you approve each channel independently.
8. **Releases** — the newsletter is sent; LinkedIn and X are handed to a person
   to post, who confirms with a URL.

---

## The one idea everything rests on

**Every fact the system publishes can be traced to a stored excerpt of a page
it actually fetched, by an identifier checked mechanically rather than
trusted.**

Three mechanisms, in order of strength:

| Mechanism | Catches |
| --- | --- |
| **Marker integrity** — every `[E12]` is resolved against the excerpt set that specific call received | A citation to a source that does not exist. The draft is discarded and rewritten; a second failure stops the request. |
| **The vector check** — each cited sentence is embedded and compared to the excerpt it cites | A *real* citation attached to a claim it does not support. Marker integrity alone cannot see this. |
| **The tripwire** — unmarked sentences carrying a number, a date, a quotation or an unknown proper noun | The model being told to cite its claims and not doing it. The instruction's outcome is measured, not assumed. |

The model is also never allowed to write a URL. It marks where a link belongs
and which excerpt it should point at; the server substitutes that source's real
URL. **A link cannot be wrong because the model never writes one.**

---

## Setting it up

1. **Fill in `.env`.** Every key is documented in place. The required ones:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
   - `ANTHROPIC_API_KEY`, `FIRECRAWL_API_KEY`, `VOYAGE_API_KEY`
   - `RESEND_API_KEY` for the newsletter
   - `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `HANDOFF_TOKEN_SECRET` —
     generate each with `openssl rand -hex 32`

2. **Start it.** `npm run dev`. The schema creates itself on first boot: the
   migrations run under a Postgres advisory lock, so several instances starting
   at once is safe, and they are recorded so they run only once.

3. **Sign in.** The first account to sign in becomes the admin. "Try the demo"
   creates a capped workspace instead.

4. **Check `/api/health`** if anything looks wrong. It reports the state of
   Postgres, each provider and each connector, so a dead dependency is
   diagnosable without reading logs.

`DEMO_MODE=true` is the default. Nothing reaches a real recipient; every send is
stored as a **dry run**, which is a distinct status and is never displayed as a
real publish.

---

## Using it

**New request** → idea, audience, optional keyword, optional source URLs,
channels, budget. The estimated cost is shown before anything is spent, and a
request estimated above its budget does not start.

If you supply URLs, **no web search runs** unless the idea asks for more. That
is a deliberate saving, and the answer to "when should this automation not run".

**Gate one** — sources with their relevance score and a checkbox; anything that
could not be read appears below with the reason, uncheckable. Uncheck what you
do not want, then pick an angle. Removing a source invalidates any angle built
on it, and says so rather than quietly continuing.

**Gate two** — the article on the left with a superscript on every cited
sentence (amber for weak, red for unsupported), and on the right: the
evaluation report, the channel versions with their format checks, image
candidates, the source list and the version history. Approve each channel
independently, edit the article directly, or send it back with a note.

A human edit **re-runs the grounding checks**. You can add an uncited factual
sentence; you will see it flagged. The check does not become optional because a
person did the typing.

**Queue** — grouped by time, connector status at the top, `uncertain` items
pinned in red.

---

## What "published" is allowed to mean

| Status | Means |
| --- | --- |
| `published` | A provider returned an identifier, stored on the row. |
| `published (dry run)` | `DEMO_MODE` was on. Nothing reached anyone. |
| `awaiting posting` | A copy-ready packet went to whoever posts it. **Not published**, however long it sits. |
| `posted by hand` | A person posted it and confirmed with a URL. A real post — and visibly not something this system did. |
| `partly delivered` | Some recipients received it, some did not, with the real counts. |
| `outcome unknown` | We cannot tell whether it sent. **Never retried automatically** — retrying an unknown send is how someone gets the same message twice. A person says which it was. |
| `not connected` | No authorised account. The item stays queued. |

LinkedIn and X are handoff channels because X has no free posting tier and
LinkedIn's self-service scope needs a verified app that was not supplied.
Generating and checking their content is fully implemented; posting on the
agency's behalf is not something this build can do honestly, so it does not
pretend to.

---

## Which model does what, and why

| Step | Model | Why |
| --- | --- | --- |
| Discovery, angle planning, channel adaptation, alt text | **Haiku 4.5** | Short, rule-bound, schema-constrained. |
| Drafting and revision | **Sonnet 5** | Publication-quality long-form prose. The largest token spend. |
| Evaluation | **Opus 5** | See below. |
| Chunking, ranking, format checks, word counts | **none** | A splitter and a cosine distance do these. A model call to do a splitter's job is money spent on nothing. |

The inversion is deliberate. The judge reads one article and writes a
paragraph; the writer reads a corpus and writes an article. **Judging costs
about a third of what writing costs**, so the stronger model goes at the
quality gate, where a mistake is most expensive — about two cents more per
article than the conventional arrangement.

---

## Cost control

- A per-request budget, checked **before every call** against that call's worst
  case. Checking afterwards is not a budget, it is a receipt.
- Crossing it stops the request at `budget_exceeded` with everything produced
  so far intact.
- A monthly global cap, and per-account and per-IP rate limits that **fail
  closed** — if the counter cannot be read, the request is refused.
- Every call is logged including discarded ones, because a rejected draft spent
  real money. A total that might be missing a call reads "at least $X".

About **$0.19** for a full request.

---

## When things go wrong

Every failure sets a state naming the step, a plain-language reason, a
structured detail, an activity-log row, and an email to the request's creator
when terminal.

**Unknown is never zero.** A source that failed to fetch is a row with a status,
distinct from one that was empty. A rubric criterion that could not be judged is
`null` with a reason, never a score. An evaluation that did not run is
`not_evaluated` and can never become `pass`. A dashboard count that could not be
read renders "—", not "0".

**Retry appears only where retrying could help.** A 404, a draft that failed
marker integrity twice, a topic that returned nothing — no retry button, because
it would do the same thing again.

---

## Running the checks

```bash
npm test           # 80 unit tests
npm run broken-pack # the deliberately broken input pack (§21.1)
npm run build      # typecheck and production build
```

The broken-input pack asserts what can be asserted offline and prints a
checklist of the cases that need a live run — a script that claimed to have
tested a fetch failure it never made would be worse than no script.

---

## Deploying

Vercel, with the same environment variables. Add a cron job hitting
`/api/cron/release` with `Authorization: Bearer $CRON_SECRET`. Five minutes is
the intended cadence; a coarser one works but a queue that drains once a day
cannot demonstrate a scheduled post going out.

The cron route also advances one in-flight request per run, so a pipeline
nobody is watching still progresses.
