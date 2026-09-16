import { describe, it, expect } from "vitest";
import { needsConnectedAccount } from "./gate";
import type { ConnectorStatus } from "@/lib/db/types";

/**
 * Whether an item is blocked for want of a connected account.
 *
 * The worker checked connector status BEFORE branching on `kind`, so a
 * LinkedIn handoff item was marked `blocked_not_connected` and never
 * dispatched — waiting forever on a credential the design deliberately does
 * not require. Handoff means a person posts it; the system only has to email
 * them the packet.
 *
 * That made the whole handoff design look broken: the queue reported two of
 * three channels "not ready" when nothing was wrong with either.
 */

const STATUSES: ConnectorStatus[] = [
  "not_connected",
  "expired",
  "revoked",
  "error",
];

describe("needsConnectedAccount", () => {
  it.each(STATUSES)("blocks a delivering channel when the account is %s", (status) => {
    expect(needsConnectedAccount("delivering", status)).toBe(true);
  });

  it("lets a delivering channel through when connected", () => {
    expect(needsConnectedAccount("delivering", "connected")).toBe(false);
  });

  it.each(STATUSES)("never blocks a handoff channel, even when %s", (status) => {
    // The credential is irrelevant: a person posts this one.
    expect(needsConnectedAccount("handoff", status)).toBe(false);
  });

  it("does not block a handoff channel that has no connector row at all", () => {
    // The common case in this build: no LinkedIn or X credential was ever
    // supplied, and none is needed.
    expect(needsConnectedAccount("handoff", undefined)).toBe(false);
  });

  it("blocks a delivering channel with no connector row", () => {
    // The newsletter genuinely cannot send without Resend configured.
    expect(needsConnectedAccount("delivering", undefined)).toBe(true);
  });
});
