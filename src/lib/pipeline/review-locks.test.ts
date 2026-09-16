import { describe, it, expect } from "vitest";
import { isArticleLocked, areChannelsLocked } from "./review-locks";
import type { RequestStatus } from "@/lib/db/types";

/**
 * Two different questions that were answered by one flag.
 *
 * `readOnly = request.status !== "content_review"` locked the entire gate-two
 * screen. Approving one channel calls `moveToScheduled`, which moves the
 * request to `scheduled` — so approving LinkedIn removed the approve button
 * from the newsletter, which was still a draft and perfectly approvable.
 *
 * One approval silently ended the review, and the only way out was to never
 * approve anything until you had decided everything. The server never had this
 * restriction; it was purely the UI locking itself.
 */

describe("isArticleLocked", () => {
  it("is open while the content is under review", () => {
    expect(isArticleLocked("content_review")).toBe(false);
  });

  it("closes once something has been approved from it", () => {
    // The approved channel versions were derived from this article, so editing
    // it afterwards would leave them describing text that no longer exists.
    expect(isArticleLocked("scheduled")).toBe(true);
  });

  it.each<RequestStatus>(["publishing", "published", "cancelled"])(
    "stays closed when the request is %s",
    (status) => {
      expect(isArticleLocked(status)).toBe(true);
    },
  );

  it("stays open on needs_human, where a person is asked to fix the draft", () => {
    // Two failed revision rounds means the system has given up and wants a
    // judgement. Locking the article would ask for that judgement and then
    // remove the only way to act on it.
    expect(isArticleLocked("needs_human")).toBe(false);
  });
});

describe("areChannelsLocked", () => {
  it("keeps channels decidable during review", () => {
    expect(areChannelsLocked("content_review")).toBe(false);
  });

  it("KEEPS CHANNELS DECIDABLE AFTER ONE IS APPROVED", () => {
    // The regression this file exists for: approving LinkedIn moves the
    // request to `scheduled`, and the newsletter must still be approvable.
    expect(areChannelsLocked("scheduled")).toBe(false);
  });

  it("keeps channels decidable while another channel is sending", () => {
    expect(areChannelsLocked("publishing")).toBe(false);
  });

  it.each<RequestStatus>(["published", "cancelled", "failed", "budget_exceeded"])(
    "closes channels once the request is %s",
    (status) => {
      expect(areChannelsLocked(status)).toBe(true);
    },
  );

  it("never locks channels while the article is merely locked", () => {
    // The article being closed must not imply the decisions are closed. That
    // conflation is the whole bug.
    const status: RequestStatus = "scheduled";
    expect(isArticleLocked(status)).toBe(true);
    expect(areChannelsLocked(status)).toBe(false);
  });
});
