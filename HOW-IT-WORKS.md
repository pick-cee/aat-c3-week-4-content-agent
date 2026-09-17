# Using Koya Content Studio

Koya turns a brief into a researched article and ready-to-review LinkedIn, X and newsletter versions. You approve the research before writing begins and each channel before it can be released.

## Start with a brief

Choose **Create content**. Describe the idea and audience, select the brand voice and channels, and set a spending limit. Add source URLs if you already have reliable material. Separate URLs with new lines. Supplying URLs skips web discovery unless the brief asks for more sources.

The estimate helps you plan; actual usage depends on the material and any revisions. The default delivery choice holds approved content in the queue until someone chooses a time.

Submit once. You can navigate elsewhere while background work continues. The content library lets you search and filter work that is running, ready for review, scheduled, published or needs attention.

## Review the research

Read the source list and its fetch/relevance warnings. Exclude unsuitable sources, then choose an angle. Changing a source invalidates angles that depended on it, so re-plan before choosing one of those.

Failed or empty source pages remain visible. The system does not treat an inaccessible page as evidence. PDFs are limited to their first five pages; provide a focused HTML source when the needed material is deeper in a document.

## Read and refine the article

The first saved draft appears while the remaining checks and channel versions are still being prepared. Read it immediately or export Markdown with its sources.

In the review workspace, inspect the article, channel copy, sources, evaluation and version history. Citation links show the supporting excerpt and its similarity score. A similarity score is a review aid, not proof that the sentence is true.

Automated checks measure citation validity, source alignment, figures, SEO, completeness and banned phrases. An editorial judge assesses the rubric. Up to two automatic revisions can repair the failed sections. If the result still needs a decision, the saved article stays available for review.

You can edit the article or request a specific revision. Human edits create a new version and run through evaluation; failed checks return to you instead of silently rewriting your edit. A reviewer or admin can accept a flagged article with a reason. Accepted overrides remain recorded.

Images are optional. Licensed photo candidates are searched automatically alongside article checks, with a short timeout and simpler fallback query. Existing candidates are reused. In the image panel, check the license and attribution and enter useful alt text when selecting one. You can retry an empty search there. Discovery uses no AI tokens and does not generate artwork.

## Approve and schedule

Review each channel independently. Approving one locks the underlying article so that its already-approved copy cannot become stale, while the other channel decisions remain available. A format warning requires an explicit override note.

Approved content held in the queue has no send time. Schedule it when ready. Only a reviewer or admin can approve or schedule.

- **Newsletter:** sends through the configured email service, checking recipient opt-in at delivery time.
- **LinkedIn and X:** sends a copy-ready packet to the person who posts it. It stays awaiting manual posting until they confirm the post URL.

The public article address becomes available only after approval of that exact version. An unapproved draft is private. Deleting a pending request cancels its pending queue entries; records already sent or with uncertain delivery must be resolved and retained.

## If something stops

A temporary provider problem shows a scheduled retry and its attempt number. A configuration or budget problem stops and explains the next action. Retry resumes saved work where possible; it does not deliberately regenerate successful outputs.

**Reserved usage** means a call is in flight or its final charge has not been confirmed. It counts against the limit. Ask the administrator to reconcile persistent unknown usage instead of assuming it was free.

If a delivery is **uncertain**, check the destination/provider before selecting “It sent” or “It did not”. The system cannot safely guess and does not automatically resend it.

Connection loss does not erase saved work. Reconnect or refresh to see the last saved state. Background execution requires the production worker described in [README.md](README.md); the browser and scheduled recovery sweep alone do not guarantee prompt completion.
