# Week 4: AI Content Research and Publishing Agent

An idea or a URL goes in; a researched, source-grounded article and three
channel-ready posts come out, with a human approving before anything is
released.

## Getting started

```bash
npm install
cp .env.example .env     # then fill it in — every key is documented in place
npm run dev
```

The schema creates itself on first boot: migrations run under a Postgres
advisory lock, so several instances starting at once is safe. Open
<http://localhost:3000> and the landing page signs you straight in.

If anything looks wrong, `/api/health` reports the state of Postgres, each
provider and each connector, so a dead dependency is diagnosable without
reading logs.

**On embeddings.** They are not optional garnish: they rank sources, choose what
goes into the drafting call, and back the weak-citation check that makes a
citation on an unrelated claim detectable (DESIGN.md §8.4). `OPENAI_API_KEY` is
therefore required, and it needs billing enabled — the whole corpus for a
request costs a fraction of a cent, but a free tier's per-minute limit silently
drops sources from the research instead of failing loudly. Changing embedding
provider invalidates every stored vector, so the two must never be mixed.

## Deploying to Vercel

Set every key from `.env.example` in the project's environment variables, then:

**Scheduled posts need a scheduler, and the free plan is not one.** Vercel's
Hobby plan allows one cron run a day and rejects a five-minute schedule, so
`vercel.json` has no `crons` block. `.github/workflows/release.yml` drives
`/api/cron/release` every minute instead, because a send time is chosen to the
minute and a five-minute cadence would turn 6:33 into 6:35. Add two repository
secrets under
Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `APP_URL` | `https://your-app.vercel.app`, no trailing slash |
| `CRON_SECRET` | the same value you set in Vercel |

Then run the workflow once by hand (Actions → Release scheduled content → Run
workflow) to confirm it returns 200 rather than 401. Without those secrets,
approved content sits in the queue past its send time and nothing says why.

While someone has the app open, a heartbeat in the layout also sends what is due
every thirty seconds, so a schedule feels immediate rather than waiting for the
next external run. That is a convenience, not the guarantee: nobody has a tab
open at 03:00.

On a Pro plan you can restore the `crons` block in `vercel.json` and delete the
workflow. Running both is harmless: the worker claims each row in one atomic
statement, so two schedulers racing is a normal outcome rather than a double
send.

## The documents

- `PRD.md` — the brief
- `DESIGN.md` — the specification. It wins over convenience; if the code and
  this document disagree, the document is what gets changed first, on purpose,
  with a reason
- `CLAUDE.md` — the standing rules the build is held to
- `HOW-IT-WORKS.md` — one page on what it does and how to use it
- `assets/` — the SEO rules, channel formatting rules and evaluation rubric,
  which are requirements rather than suggestions

**Three channels, not four.** DESIGN.md §2.12 proposed WhatsApp as a fourth and
it was dropped. The code and schema are the authority; where those two
documents still describe a WhatsApp broadcast, the code is right.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the app. Migrations and seed run automatically. |
| `npm run build` | Production build, including a full typecheck. |
| `npm run typecheck` | Types only. |
| `npm test` | 188 unit tests. |
| `npm run broken-pack` | The deliberately broken input pack (DESIGN.md §21.1). |
| `npm run db:push` | Apply migrations by hand. Shares its ledger and advisory lock with the startup runner, so the two cannot disagree about what is applied. |
| `npm run db:seed` | Apply migrations and seed the demo account, brand voice, connectors and recipients. Idempotent. |

### The verification scripts

These exist because each one caught a real bug that the type system could not.
They talk to the live project, so they need `.env` filled in.

| Command | Catches |
| --- | --- |
| `npm run verify:grants` | A function executable by `public`, `anon`, or by `authenticated` beyond the two named reads. Postgres grants EXECUTE to PUBLIC by default, so this is one `create function` away from recurring — it is a standing check, not an audit. |
| `npm run verify:selects` | A `select()` naming a column that no longer exists. These fail at runtime with the whole query erroring, and `data ?? null` turns that into a silent wrong answer — a dropped column once logged every user out. |
| `npm run verify:schemas` | A structured-output schema the API rejects. It refuses `minItems` above 1, `maxItems`, and numeric bounds — and only says so at call time, three pipeline steps and real money later. |

## What it is built to do

Every fact it publishes is traceable to a stored excerpt of a page it actually
fetched, by an identifier checked mechanically rather than trusted. A citation
to something that does not exist cannot be saved; one attached to an unrelated
claim is caught by comparing the sentence to the excerpt by vector distance.

Nothing publishes without a person approving that channel. LinkedIn and X are
handed to a person to post and stay marked as awaiting posting — never as
published — until they confirm with a URL.

And it is honest about what it does not know. A source that failed to fetch is
distinct from one that was empty. A send whose outcome nobody can account for
is `uncertain`, never retried automatically, and counted separately from a
failure. A count that could not be read shows a dash, not a zero.

The same distinction applies to indexing. A source the embedding service merely
rate-limited is retried automatically and says so; one that genuinely cannot be
indexed is marked and left for manual inclusion. Collapsing those two into a
single "failed" flag once discarded six good articles and surfaced, three steps
later, as a complaint that the angles looked too similar — so the difference is
recorded in the table, not inferred.

It also never claims to be retrying when it is not. The word "retrying" appears
only when another attempt is genuinely scheduled, with the attempt number shown;
a failure that cannot succeed on a second try — a budget that has run out, for
instance — stops immediately and says what it needs and who can supply it. A
spinner that never resolves is worse than an error, because an error can be
acted on.
