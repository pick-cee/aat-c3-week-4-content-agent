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
| `npm test` | 107 unit tests. |
| `npm run broken-pack` | The deliberately broken input pack (DESIGN.md §21.1). |
| `npm run db:push` | Apply migrations by hand. |
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
