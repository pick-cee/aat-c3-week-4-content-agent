# Koya Content Studio

An editorial workspace for one agency: research a brief, review the sources and angle, generate a grounded article, prepare LinkedIn/X/newsletter copy, and approve each channel before release.

The September 2026 refactor replaces browser-dependent step execution with resumable background work, adds provider cost reservations and response checkpoints, and rebuilds the content library, creation flow, navigation and review experience. See [the implementation and validation notes](REFACTOR.md) and [the editor's guide](HOW-IT-WORKS.md).

## Local setup

Use Node **22.12+ (22 LTS)** or **24+** and npm **11.19.1**. Node 23 is outside the test runner's supported versions. `.nvmrc` selects 22. npm 10 can fail to resolve the security overrides in this project.

```sh
npm install --global npm@11.19.1
npm ci
```

Copy `.env.example` to `.env` and fill in the required credentials. Existing databases require migrations **0025 through 0030** before running the updated app. Apply them explicitly below, or set `AUTO_MIGRATE=true` for local startup to apply pending files. Applied migrations are skipped; a build does not apply them.

```sh
npm run db:push
npm run db:seed
npm run dev
```

For the demo account on the normal development server (`http://localhost:3000`), set these values in your existing `.env`:

```dotenv
DEMO_MODE=true
ENABLE_DEMO_LOGIN=true
DISABLE_PUBLISHING=true
RESEND_API_KEY=
AUTO_MIGRATE=false
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Sign-in depends on the environment configuration, not the port. Restart the app and worker after changing `.env`. These are local demo settings; configure production separately in its deployment environment.

In a second terminal, run the development worker. It loads `.env` and picks up requests created after it starts:

```sh
npm run dev:worker
```

To exercise background drafting without starting the release worker, run `node scripts/dev-worker.cjs --content-only`. This uses the same `.env` and does not change its publishing configuration.

The worker processes content requests and releases approved, due queue items. Point development at a separate database and use `DEMO_MODE=true`. Demo delivery can still send to an explicitly configured redirect inbox. Leave `RESEND_API_KEY` empty when no email should leave the environment.

Set `ENABLE_DEMO_LOGIN=true` to provision and allow the Maya demo account. This works with either `DEMO_MODE=true` or `DEMO_MODE=false`; `DEMO_MODE` controls delivery routing independently of account access. Keep demo access disabled for client work. `AUTO_MIGRATE=true` is an explicit local convenience only; it is not the production deployment path.

## Production setup

1. Back up the database and pause existing workers during the upgrade. Run `npm run verify:refactor` against a staging copy first. It applies pending migrations and tests them inside one transaction, then rolls everything back. It requires an existing reviewer profile.
2. Apply `npm run db:push` once during deployment. It uses the existing migration ledger and advisory lock. Do not use `--force` for a normal upgrade. Run `npm run db:seed` to create missing brand voice and connector rows; it does not add recipients.
3. Provision agency accounts in Supabase Auth, then add matching `content_agent.profiles` rows with the Auth user UUID, email, name, role (`manager`, `reviewer`, or `admin`) and `is_demo=false`. Public signup is not an onboarding path. Provision at least one admin. Use Supabase's admin tools for password resets. Demo credentials cannot read workspace tables directly.
4. Deploy the Next.js app with `AUTO_MIGRATE=false`, `ENABLE_DEMO_LOGIN=false`, the same database/provider settings, and the correct public `NEXT_PUBLIC_APP_URL`. Set a deliberate monthly spending limit. `DEMO_MODE` defaults to true; set it to false only when actual delivery is intended and configured.
5. Run **`npm run worker` as a supervised, continuously running Node process** with the same environment. Install development dependencies on the worker because the entry point uses `tsx`. Restart it on failure; allow at least 240 seconds for graceful shutdown. Multiple workers share atomic database claims. The web app can be on Vercel while this process runs on your existing server or worker host.
6. Verify `/api/health`, a short held request, both human review gates, and queue behavior in staging. Provider checks in health report configuration presence, not live availability. Missing core configuration or schema returns 503. Signed-in members see diagnostic details; anonymous monitors see status only.

The web routes allow 300 seconds. Submission returns promptly and schedules a bounded background drain through Next.js `after()`. The dedicated worker continues after that drain or after the browser closes.

`.github/workflows/release.yml` is a **five-minute recovery sweep**, using repository secrets `APP_URL` and `CRON_SECRET`. GitHub schedules can be delayed and cannot guarantee an exact publish minute. Do not use this sweep as the only driver when predictable generation and delivery latency matter. The browser's authenticated heartbeat is an additional wake-up mechanism. See [GitHub's scheduling constraints](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Configuration

| Variables | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser authentication; the anon key grants no workspace content access. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only data access. |
| `SUPABASE_DB_URL` | Direct database connection for migrations and integration checks. |
| `ANTHROPIC_API_KEY`, `FIRECRAWL_API_KEY`, `OPENAI_API_KEY` | Generation/search, source reading, and embeddings. All three are required for research. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_REPLY_TO` | Notifications and newsletter/handoff email. Use a verified sender. |
| `HANDOFF_POSTER_EMAIL` | Person receiving LinkedIn/X posting packets. |
| `CRON_SECRET`, `HANDOFF_TOKEN_SECRET` | Independent random secrets for worker access and signed posting confirmations. |
| `TOKEN_ENCRYPTION_KEY` | 64 hexadecimal characters for connector encryption. |
| `DEFAULT_REQUEST_BUDGET_CENTS`, `MONTHLY_GLOBAL_CAP_CENTS` | Defaults: 150 cents per request, 5,000 cents per month. |
| `DEMO_WORKSPACE_BUDGET_CENTS` | Demo request ceiling; defaults to 60 cents. |
| `OPENVERSE_CLIENT_ID`, `OPENVERSE_CLIENT_SECRET` | Optional image search credentials. Images are selected after drafting; alt text is entered by a person. |

The remaining rate limits and demo switches are listed in `.env.example`. Never commit `.env` or expose service keys in client components.

For a local demo of the production build, use `npm run build` followed by `npm run preview`, then open `http://127.0.0.1:3100`. This command enables local demo access, starts a worker for new requests and sets `DISABLE_PUBLISHING=true` with outbound email disabled. See [the test handoff](REFACTOR.md#local-test-handoff) for credentials.

## Cost and recovery

The form shows a planning estimate, not a guaranteed quote. Before a paid call, the database reserves an allowance against both the request and workspace limits. Provider responses replace that allowance with measured usage. Cache writes, cache reads, discarded output and embedding batches all count. Fractional cents are retained in receipts and rounded at the request total.

An interrupted call can have unknown usage. Its reservation remains visible and prevents that allowance being spent again. Do not clear it just to make a request run. Reconcile the receipt against the provider's usage records; [REFACTOR.md](REFACTOR.md) explains the operational limits. Provider token/credit reporting and the price table still determine final actual cost; the allowance is not a billing cap enforced by the external provider.

Supply reliable source URLs to skip discovery unless you ask for more sources. Page reads use basic scraping, verified TLS and at most five PDF pages. Firecrawl's own cache still costs a credit. Within one request, a saved successful scrape or generation response is reused on recovery without buying it again.

Transient failures get bounded retries with stored deadlines. Configuration, invalid-output and budget failures stop with the work saved. Unknown **delivery** outcomes are never automatically resent; a reviewer must resolve them.

## Validation commands

| Command | What it checks |
| --- | --- |
| `npm test` | Deterministic regression tests; no paid providers or emails. |
| `npm run typecheck` | TypeScript types. |
| `npm run build` | Production routes, server/client boundaries, types and assets. |
| `npm run verify:refactor` | Database behavior in a rolled-back transaction; no generation or email. |
| `npm run verify:selects` | Read-only checks of runtime select columns; apply migrations first. |
| `npm run verify:server` | Read-only HTTP rendering checks against a running local preview; optional authenticated session. |
| `npm run verify:grants` | Read-only audit of this application's database function grants. |
| `npm run verify:schemas` | Six small **paid** calls validating the actual structured-output schemas and configured model IDs. Prints observed cost. |
| `npm run broken-pack` | Legacy scenario harness. Use an isolated test database; it creates records and can exercise delivery. |

CI runs the deterministic suite, production build and dependency audit. Integration tests and paid schema probes are explicit operator commands.

## Scope and documents

This is one shared agency workspace with roles, not a multi-tenant SaaS. Use separate deployments/databases for unrelated clients until tenant isolation is implemented. LinkedIn and X use human posting handoffs; the newsletter sends through Resend to opted-in recipients.

- [DESIGN.md](DESIGN.md): specification, with the September refactor amendments taking precedence.
- [CLAUDE.md](CLAUDE.md): repository rules and historical implementation context.
- [PRD.md](PRD.md): original product brief.
- [assets](assets/): SEO requirements, evaluation rubric and channel formatting rules.
