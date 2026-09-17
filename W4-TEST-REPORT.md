# Week 4 test report

Date: 17 September 2026. Reference: `C:/Users/akinl/Downloads/w4-test-pack.md`.

The email now uses the actual subject and body, without the dry-run prefix or banner. Demo recipient routing and internal delivery metadata remain intact. The user-approved live test submitted the same newsletter twice with one idempotency key; Resend returned the same message ID both times.

The latest complete content run reached a first draft in **155.5 seconds** and finished evaluation, two automatic revisions, and all three channels in **294.4 seconds**. Channel preparation took **26.7 seconds**. One other editorial test still required a person after its revision limit. This is useful progress, but not an unconditional production-readiness sign-off.

## Method and timing

Real database, search, scraping, embeddings, writing, evaluation, and image discovery were exercised through `scripts/w4-benchmark.ts`. Timing starts immediately before inserting the request. The harness chooses the first research angle automatically and then calls the real pipeline runner. These are engine timings, not browser form-to-screen timings; human decision time is excluded. A normal user still needs to choose an angle.

Only the existing `.env` was loaded. No override env files were created or changed. Generation fixtures had a $1.50 budget; this deliberately tests the engine independently of the demo UI's lower budget cap. Email was disabled inside generation-test processes. Only the separately approved newsletter delivery used the live email provider.

Some runs overlapped, providers may cache responses, and source results differed between runs. This small sample does not establish a percentile latency or a controlled before/after speedup. Local observation timestamps are used because database timestamps differed slightly from the local clock.

| Live case | Research ready | First draft from input | Angle selection to draft | Ready for review / stopped | Recorded cost |
|---|---:|---:|---:|---:|---:|
| Row 1, initial raw idea | 73.9 s | 124.9 s | 50.7 s | 220.8 s; newsletter format failed | $0.18 |
| Row 2, three supplied sources | 50.8 s | 98.0 s | 47.1 s | 227.2 s; all channels passed | $0.12 |
| Row 4, single-source scorecard | 35.1 s | 76.7 s | 41.4 s | 157.3 s; editorial review needed | $0.13 before replay |
| Row 1, fresh run after fixes | 104.0 s | 155.5 s | 51.4 s | 294.4 s; two revisions, all channels passed | $0.24 |
| Row 8, mixed broken URLs | 48.0 s | Not requested past angle gate | — | Research only | $0.02 |
| Niche guild topic | 126.9 s | Not requested past angle gate | — | Research only; scraping retry recovered | $0.07 + $0.006 unresolved reservation |

The fresh run was slower overall because research and article revisions took longer. Parallel channels address one measured bottleneck: the earlier three-source run spent about 110 seconds across serial channel steps; the new raw-idea run completed the parallel channel step in 26.7 seconds. These used different articles and retry counts, so that comparison is descriptive, not a measured percentage improvement.

## Test-pack results

| Row | First attempt | Fix or retest | Result and limits |
|---|---|---|---|
| 1. Raw idea | Six readable sources, three angles, first article passed evaluation. LinkedIn and X recovered through existing retries. Newsletter remained invalid after its retry. | Tightened channel length and newsletter structure instructions; fresh run passed every channel check. | Generation works; initial newsletter failure is recorded, not counted as a first-pass success. Exact angle similarity threshold from the pack is not certified. |
| 2. Supplied URLs | All three sources read successfully; zero web-search calls. Article passed its first evaluation. | No source-discovery fix needed. LinkedIn and newsletter needed their existing format retries. | Passed research/drafting on first attempt; complete channel package passed after automatic retries. |
| 3. Grounding | 44 marked claims: 41 grounded, one weak, two unsupported; 80% marked ratio, zero numeric disagreements. | Existing computed grounding thresholds passed. | Scoring is active, not an all-unscored fallback. A pass does not mean every claim is supported. Visual superscript/popover interaction was not verified in a browser. |
| 4. Targeted revision | Two revisions retained version ancestry, but targeted weak advisory claims while editorial issues remained; final rewrite also lost both links. | Prioritize factual targets when their computed check actually fails; include original brief and judge reasons; preserve existing approved links in rewritten sections. Replay kept two links and improved relevance 2→4 and clarity 2→3. | Partially fixed. Replay still scored tone 2 and correctly stopped for review after two revisions. No claim of unattended completion for this case. |
| 5. Approval/security | Database approval constraint, anonymous RPC denial, and unauthenticated cron checks passed. Existing approval tests passed. | No new security migration required for these checks. | Passed automated/database checks; no unapproved real publication attempted. |
| 6. Channel contracts | Initial raw-idea newsletter was 602 words with a four-sentence introduction. Three-source output eventually passed all formats. | Updated prompts; fresh run produced a 476-word newsletter with a two-sentence introduction, 188-character weighted X post, and 2,594-character LinkedIn post with ordered PAS spans. | Latest live package passed. Controlled E99 injection retries once then fails without saving invalid output. Newsletter HTML rendering and clean email payload are tested; inbox visual rendering is not certified. |
| 7. Idempotency/handoff | Concurrent database release claims and delivery uniqueness passed. New handoff regression tests exposed confirmation of a cancelled item and duplicate activity under concurrent confirmation. | Confirmation now requires awaiting-manual-post status and uses a conditional update; repeated confirmation of an already posted item is idempotent. | Three handoff regression tests pass. Live Resend duplicate replay returned one ID. Full simultaneous cron-to-email execution and live handoff emails were not run. |
| 8. Broken sources | Six URLs produced one usable source and five explicit failures/empty results; planning continued without crashing. | No product change required for fetching these inputs. Corrected two obsolete column names in the reporting harness. | Recovery passed. Current policy permits a single explicitly supplied usable source; the pack's stronger source-diversity expectations are not fully met. |

## First-pass checks and fixes

The initial unit baseline passed **255 tests in 23 files**. The final suite passed **265 tests in 28 files**, and TypeScript checking passed after fixing a new test mock's argument type. Existing refactor database verification passed **20 checks**. The broken-input pack passed **30 checks** with network access enabled; its initial sandbox run had 29 passes and one network-blocked grants check, which was an environment limitation rather than a product defect.

Additional real database/API checks passed **12/12**:

- Duplicate submission token: PostgreSQL `23505`, unique constraint enforced.
- A five-cent request cannot reserve a nine-cent provider call; no model call starts.
- Expired lease can resume the stored step; its previous owner cannot renew it.
- Missing `approved_by`: PostgreSQL `23502`, NOT NULL constraint enforced.
- Two simultaneous release claims on separate connections: `[1, 0]`, attempt remains 1.
- Duplicate delivery recipient/queue pair: PostgreSQL `23505`.
- Timed-out pending delivery becomes `uncertain` with `no_provider_response`, avoiding an unsafe blind retry.
- Anonymous calls to claim, counter, and cost RPCs return HTTP 401 / `42501`.
- Cron without its secret returns 401.

Final authenticated HTTP smoke checks passed **13 checks**, including password sign-in, workspace, request creation page, queue, settings, recycle bin, available article routes, private-route protection, and secret absence from HTML. These are server-rendering checks, not browser interaction tests.

The final production build (`npm run build`) passed, including type validation, page generation, and build traces. `git diff --check` passed. The development server was restored on port 3000 and the content-only worker restarted for newly created requests; queued publishing remains outside that worker.

Changes made during this test run:

1. Removed dry-run decoration from email subject and body while preserving demo routing.
2. Prepared missing channels concurrently; await all siblings before surfacing a failure and skip already saved channels on retry.
3. Gave channel generation safer length targets and explicit newsletter introduction/sign-off instructions.
4. Improved revision target priority and included the original brief and failed editorial reasons.
5. Preserved approved links that revisions would otherwise drop.
6. Fixed cancelled and concurrent handoff confirmation cases.
7. Added regression coverage for these changes, no-source recovery, and unknown channel citations.

Two test-harness issues are not product defects: obsolete reporting columns were corrected, and a controlled channel replay was refused because its fixture was not in a running state. That replay was abandoned without further paid generation; the fresh full run supplies the final parallel-channel evidence.

## Broken-source outcomes

These are actual saved application classifications, not inferred HTTP statuses.

| Input | Saved outcome | Included |
|---|---|---|
| example.com fake 404 path | fetch_failed | No |
| ft.com placeholder article path | fetch_failed | No |
| W3 dummy PDF | empty | No |
| example.com home page | empty | No |
| GitLab all-remote hiring handbook URL | empty | No |
| JobScore interviewing best practices | ok | Yes |

The niche guild topic found three usable sources, so it did not exercise a real zero-result search. It did exercise a real scraping HTTP 408, retry delay, and reuse of already fetched sources. A controlled runner test separately verifies empty discovery stops with `needs_human` and produces no draft. The unresolved scraping reservation remains visible instead of claiming the failed call was free.

## Approved email delivery

Subject: **Stop comparing vibes. Compare evidence instead.**

Recipient: the user's approved Gmail address. Two identical submissions used the same idempotency key. Both returned `01a0af3a-56d0-7673-befe-467c08fccb4c`; the provider status was `sent`. This verifies provider acceptance and idempotent replay, not independent confirmation of inbox receipt. Internal `isDryRun` remained true because demo routing was enabled; that metadata is no longer added to the subject or message body.

Preview: [newsletter-preview.html](tmp/w4-tests/newsletter-preview.html). Delivery evidence: [live-email.json](tmp/w4-tests/live-email.json).

## Remaining gaps

- Editorial quality is not guaranteed to converge within two revisions. The scorecard replay still needed review, and the failure banner can omit the specific editorial reason when all computed checks pass.
- The planner can retain angles with warnings after its retry limit. Its current similarity threshold is 0.85, whereas the pack asks for under 0.70; strict angle-diversity acceptance has not passed this run.
- The initial failed newsletter fixture remains available for inspection; the passing retest is a separate fresh request.
- Six licensed image candidates were discovered for each evaluated article. These are Openverse candidates, not newly generated AI artwork; research-only fixtures had none. Visual image selection/display was not browser-tested.
- No browser surface was available for screenshots, mobile layout checks, citation popovers, double-click interaction, or visual delete-button verification. HTTP and unit checks do not replace those tests.
- Lease takeover was tested using expired database state. A real worker was not killed in the middle of a paid provider request.
- Live handoff emails and a full pair of simultaneous release-cron requests were not sent. Database concurrency, mocked handoff actions, and the separately approved provider replay cover distinct parts of that path.
- The test-pack counts and several historical migration issues are stale. Existing migrations already address the tested approval and RPC constraints; they were not newly fixed today.

## Evidence and reproduction

Machine-readable evidence is in `tmp/w4-tests/` (local test artifacts, not committed by default). Durable harnesses are `scripts/w4-benchmark.ts` and `scripts/w4-database.ts`. Do not rerun the live-send script without authorizing another email test. Generation benchmarks incur provider costs.

Local checks: `npm test`, `npm run typecheck`. Connected checks: `npm run broken-pack`, `npm run verify:refactor`, and `npx tsx --require ./scripts/stub-server-only.cjs scripts/w4-database.ts`. For the HTTP smoke check, set process-only `SMOKE_APP_URL=http://localhost:3000` and `SMOKE_DEMO_LOGIN=true`, then run `npm run verify:server`.

Retained request IDs for review:

| Fixture | Request ID |
|---|---|
| Raw idea, initial | `873df5f4-8194-495a-bda5-3a7dab1ba235` |
| Raw idea, final passing channels | `9d5461fe-2947-4de4-b629-ac4d53259e20` |
| Three supplied sources / approved email | `ae3e2fc5-7f03-4d97-bc3b-3638818f7bb9` |
| Scorecard / revision replay | `9402707e-8634-4ddb-b155-b9a9dc33a1ea` |
| Broken URLs | `53b63bad-2561-4558-9670-fda2b95a3c50` |
| Niche guild topic | `bbbc579c-0c29-46e4-ba8b-d599bfbcf3bc` |

No test article was approved or published by the generation harness. The explicitly approved newsletter test was a separate direct provider call.
