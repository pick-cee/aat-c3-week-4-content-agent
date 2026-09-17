# September 2026 refactor

## What changed

The request runner now claims a job once, records attempts before starting, renews its lease, saves the outcome before releasing it, and fences state transitions against a stale lease. The old scheduled path claimed work and then tried to claim it again. Retries now have stored deadlines and explicit limits instead of multiplying provider retries, step retries and browser requests.

Submission and review actions queue background work immediately. `scripts/worker.ts` can continuously process jobs without a browser. Each channel adaptation is a separate resumable unit. A first draft is visible during evaluation and adaptation; optional images no longer hold it up.

Generation uses compact prompts, bounded outputs, Sonnet for writing/judging and Haiku for planning/channel formatting. Metadata is extracted from the draft without an extra model call. Successful model and scrape responses are saved for reuse after persistence failures. Unchanged claims reuse their previous grounding checks. Revisions are limited to named sections, including the opening and missing outline sections, with validation before accepting a response.

Every paid operation reserves an allowance in the database before contacting the provider. Concurrent work checks the combined request allowance and workspace monthly limit. Confirmed receipts replace reservations atomically. Retries reuse receipt IDs when saving usage, and rejected model responses update their existing receipt. Cache writes, reads, fractional embedding charges and unknown usage are handled separately.

Choosing an angle, editing an article, changing sources, approving channels and stopping a request use transactional database operations. Approval checks the latest article/output versions. Late responses cannot restart a cancelled request. Unknown deliveries still require a person's decision.

The redesigned workspace has persistent responsive navigation, a searchable paginated library, useful status filters, a focused brief form, a visible spend limit, reconnecting progress, early article previews, Markdown export, and supporting excerpts in citation tooltips. Review panels use the shared visual system.

Public pages require approval of the exact version. Anonymous access to workspace tables and profile self-escalation were removed. Other applications' Supabase accounts are not workspace members. Public demo credentials cannot read the private tables directly. Demo sign-in is disabled by default in production, while real accounts use password authentication and atomic sign-in rate limits.

## Validation on 17 September 2026

- 242 deterministic tests passed across 20 files, covering existing publishing/formatting rules and new recovery, spending, privacy and section-revision behavior.
- 20 database checks passed in a transaction that rolled back all test records and migration changes. Checks include exclusive claims, stale leases, retry deadlines, budget reservations, receipt idempotency, atomic approvals, cancelled delivery and demo access.
- The production Next.js build passed.
- Six actual structured-output schemas were accepted by the live Anthropic API, including the Sonnet revision and judge schemas. Reported probe cost: **$0.0051**. Schema acceptance is not an article-quality or latency benchmark.
- Twelve HTTP/server-rendering checks passed across signed-out and signed-in routes, including submitting the actual password form. No browser JavaScript was executed by those checks.
- The updated dependency audit reported zero known vulnerabilities.
- After migration, 71 runtime select lists and 46 database function grants passed verification.

Migrations **0025–0030 were applied to the configured database** after the rollback checks. The hosted application has not been redeployed by this refactor. Keep the hosted app and worker on the new revision together.

## Local test handoff

```sh
npm run build
npm run preview
```

Open `http://127.0.0.1:3100`. The preview starts the production web build and a worker for requests created after the preview starts. It explicitly enables the local demo account, disables publishing and outbound email, and does not rewrite `.env`. It binds the web server to the local loopback interface. Existing historical requests are not automatically picked up by this preview worker.

Sign in as `maya@koyatalent.demo` with password `koya-content-demo`, or use the demo entry button. This is a public demo credential, not a production client account. The demo request budget is capped by `DEMO_WORKSPACE_BUDGET_CENTS` (60 cents by default).

For the read-only route check, run `npm run verify:server` with `SMOKE_DEMO_LOGIN=true` against this local preview. For a non-demo test account, use `SMOKE_EMAIL` and `SMOKE_PASSWORD` instead. Credentials stay in process memory and are not printed by the check.

## Remaining release checks

### September 17 review recovery

- Fixed a verified false positive: `84%` now matches `Eighty-four percent` in the cited source. Comparisons use complete numeric values and distinguish percentages from counts.
- Automatic revisions locate the sections containing failed numeric/source checks before spending the section limit on editorial suggestions. Revised titles follow the actual H1.
- Mechanical checks carry a version. When checker logic changes, the runner recomputes checks and reuses a valid editorial assessment for the unchanged article, avoiding another paid judge call.
- Licensed image discovery runs alongside evaluation, reuses saved candidates, and has a shared 12-second deadline across short fallback queries. Image-provider failures do not fail the article.
- Saved/model placeholder review notes are omitted. Empty channel lists no longer display an all-decided banner.
- Local configuration is `.env`. The development worker supports `--content-only` for draft preparation without running releases.

Validation: 252 tests passed across 22 files, TypeScript passed, and the production build passed. The reported saved version passed a refreshed evaluation without another rewrite or paid editorial call; LinkedIn, X and newsletter drafts reached content review. No channel was approved or published during recovery.

The browser connector was unavailable, so desktop/mobile visual layout and client interactions have **not** been visually verified. Server rendering and the production build are verified. Test the creation flow, both review gates, editing, budget recovery and responsive navigation in a browser before presenting this to clients.

No end-to-end article generation benchmark was run during the refactor. Measure submission-to-research-review and angle-selection-to-first-draft separately; time spent waiting for a person is not generation latency. Record median/tail timings, failure rates, number of paid calls and actual cost across representative briefs. Do not advertise a specific completion time or saving percentage from the structural changes alone.

A continuously running worker is required for predictable completion when nobody has a tab open. The included five-minute GitHub workflow is recovery coverage, not a latency guarantee. Hosting and process supervision still need to be configured for the production deployment. This remains a single-agency workspace, not tenant-isolated SaaS.

## Unknown usage

An interrupted provider call can leave `model_calls.usage_complete=false` and a nonzero `cost_ceiling_cents`. The request displays that reservation; it does not label the call free. An administrator must verify the charge against the provider before finalizing it. The `record_model_call` RPC can finalize the **same receipt ID** with confirmed usage/cost; do not create another receipt or clear totals manually. Retain a reconciliation note in the receipt error/purpose fields.

Legacy requests with untracked incomplete usage stop further paid work until their accounting is reconciled. There is no self-service reconciliation screen in this release. Raising a request limit does not erase a reservation or bypass the workspace limit. Token and PDF allowances are estimates, not provider-enforced billing caps.

Image storage uses the public `images` bucket. Create it with JPEG/PNG/WebP restrictions and a 10 MB limit if it does not already exist. Failed storage falls back to the selected image's original URL.

## Operational references

- [Next.js background work with after](https://nextjs.org/docs/app/api-reference/functions/after).
- [GitHub Actions scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
- [Anthropic model pricing and cache accounting](https://platform.claude.com/docs/en/about-claude/pricing).
- [Firecrawl scrape options](https://docs.firecrawl.dev/api-reference/endpoint/scrape).
- [Next.js August 2026 security release](https://nextjs.org/blog/august-2026-security-release).
