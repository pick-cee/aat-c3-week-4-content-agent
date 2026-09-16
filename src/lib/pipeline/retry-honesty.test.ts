import { describe, it, expect } from "vitest";
import { willRetryAfterFailure } from "./runner";
import type { RequestStatus } from "@/lib/db/types";

/**
 * The runner must not claim a retry it will not perform.
 *
 * `runStep` returned `more: false` for EVERY failure, including retryable
 * ones. It wrote "Trying again (attempt 1 of 3)" to the activity log, and the
 * client poller — the only thing that performs that retry while someone is
 * watching — read the same response and stopped. The retry never happened; the
 * request sat at `evaluating` behind a spinner indefinitely.
 *
 * `more` has to mean "a retry is actually coming". These cases pin that down.
 */

const RUNNING: RequestStatus[] = [
  "researching",
  "drafting",
  "evaluating",
  "revising",
  "adapting",
];

/** States where no further automatic work happens, for whatever reason. */
const TERMINAL: RequestStatus[] = [
  "budget_exceeded",
  "failed",
  "needs_human",
  "cancelled",
  "published",
  "plan_review",
  "content_review",
];

describe("willRetryAfterFailure", () => {
  it.each(RUNNING)("keeps polling while the request is still %s", (status) => {
    expect(willRetryAfterFailure(status)).toBe(true);
  });

  it.each(TERMINAL)("stops polling once the request is %s", (status) => {
    expect(willRetryAfterFailure(status)).toBe(false);
  });

  it("never promises a retry after the budget is gone", () => {
    // The case that surfaced this: evaluation refused for lack of budget is
    // permanent. Retrying costs the same money that is already absent, so a
    // retry is guaranteed to fail identically — and the UI said "retrying
    // usually clears it" about the one thing retrying can never clear.
    expect(willRetryAfterFailure("budget_exceeded")).toBe(false);
  });

  it("stops polling at a human gate rather than spinning on it", () => {
    // plan_review and content_review are waiting on a person, not on work.
    expect(willRetryAfterFailure("plan_review")).toBe(false);
    expect(willRetryAfterFailure("content_review")).toBe(false);
  });
});
