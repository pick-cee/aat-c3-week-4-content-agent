# Revise a channel without rewriting the article

Open **Channels**, choose **Revise Newsletter**, **Revise LinkedIn**, or **Revise X**, and describe the specific change. For example: "Rewrite only the opening paragraph to be more direct. Add a friendly sign-off. Keep the remaining sections."

The worker receives the current article, existing channel copy, format failures and your instruction. The article remains the factual source. It is instructed to preserve unrelated sections. Only the selected platform is generated again; research, article drafting and the other channel adaptations are not repeated.

Existing citation-marker checks and channel format checks run again. Revisions additionally reject figures and links absent from the article, with one bounded retry. These checks do not prove semantic equivalence of every paraphrase; the new copy still needs human review and approval.

Approved copy can be revised too. Its pending queue item is cancelled atomically when revision is requested. Previously delivered copies and their records remain unchanged. Unresolved or in-flight delivery must be resolved before revision. Other channel approvals and schedules remain saved; queued delivery waits while revision runs.

The result is a new, unapproved channel version against the same article version, with the previous output and revision note recorded. Failed format checks stay visible and still require an explicit override note on approval. A completed sibling cannot mark the request finished while a revised channel needs review. An already approved public article remains accessible during channel revision.

Activity records the revision request and saved version, with the channel name and your note shown beneath each entry. Format failures appear as warnings. Entries commit with the revision and worker retries do not duplicate them. Existing revisions are backfilled using their original timestamps. Notes are redacted for display and are not copied into diagnostic logs.

Migrations: `0031_channel_revisions.sql` and `0032_channel_revision_activity.sql`. Apply with `npm run db:push`, or restart with the existing `AUTO_MIGRATE=true` setting. No additional environment variables are required.

Verification: `npm test`, `npm run typecheck`, and `npx tsx scripts/verify-channel-revisions.ts`. The database script rolls back all fixture changes and does not call AI or send email.
