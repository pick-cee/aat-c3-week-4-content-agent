import type { RequestStatus } from "@/lib/db/types";

/**
 * What is still editable at gate two, and what is still decidable.
 *
 * These are two different questions and were previously answered by one flag:
 * `readOnly = status !== "content_review"`. Approving a single channel calls
 * `moveToScheduled`, which moves the request to `scheduled` — so approving
 * LinkedIn removed the approve button from the newsletter, even though the
 * newsletter was still a draft and the server would have accepted it.
 *
 * Pure and separate from the component so the distinction is testable: the bug
 * was invisible to the type system and visible only by clicking Approve once.
 */

/**
 * The article is closed for editing once anything has been approved from it,
 * because the approved channel versions were derived from this text.
 */
export function isArticleLocked(status: RequestStatus): boolean {
  // `needs_human` after two revisions is precisely the case where a person is
  // being asked to fix the draft themselves. Locking it would ask for a
  // judgement and then withhold the only tool for acting on it.
  return !["content_review", "needs_human"].includes(status);
}

/** States in which no further channel decision is meaningful. */
const CHANNEL_DECISIONS_CLOSED: readonly RequestStatus[] = [
  "published",
  "cancelled",
  "failed",
  "budget_exceeded",
];

/**
 * Channels stay decidable while the request is live. A channel that has not
 * been approved or rejected is outstanding work, and the reviewer must be able
 * to finish it whatever the other channels have done.
 */
export function areChannelsLocked(status: RequestStatus): boolean {
  return CHANNEL_DECISIONS_CLOSED.includes(status);
}
