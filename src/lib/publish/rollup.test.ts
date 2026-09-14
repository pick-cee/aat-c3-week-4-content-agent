import { describe, it, expect } from "vitest";
import { rollUpDeliveries, isAlreadyHandled } from "./rollup";

/**
 * The rule under test is rule 9b: nobody receives the same broadcast twice,
 * and §17: a status must never claim to know more than it does.
 */

const tally = (over: Partial<Parameters<typeof rollUpDeliveries>[0]> = {}) => ({
  sent: 0,
  failed: 0,
  uncertain: 0,
  skipped: 0,
  ...over,
});

describe("isAlreadyHandled", () => {
  it("skips a recipient who has been sent to", () => {
    expect(isAlreadyHandled("sent")).toBe(true);
    expect(isAlreadyHandled("delivered")).toBe(true);
  });

  it("skips a recipient whose outcome is unknown", () => {
    // The bug this replaces: a timed-out delivery was recorded as `failed`, so
    // the retry re-sent it and that subscriber received the newsletter twice.
    expect(isAlreadyHandled("uncertain")).toBe(true);
  });

  it("re-sends to a recipient the provider refused", () => {
    // A real failure IS safe to retry — the provider told us it did not go.
    expect(isAlreadyHandled("failed")).toBe(false);
    expect(isAlreadyHandled("pending")).toBe(false);
  });
});

describe("rollUpDeliveries", () => {
  it("publishes when every attempted send succeeded", () => {
    const result = rollUpDeliveries(tally({ sent: 40 }), false);
    expect(result.status).toBe("published");
    expect(result.message).toContain("40 of 40 delivered");
    expect(result.needsAttention).toBe(false);
  });

  it("marks a DEMO_MODE send as a dry run, never as published", () => {
    // §19.6: a dry run is a distinct value and is never rendered as a real
    // publish.
    expect(rollUpDeliveries(tally({ sent: 3 }), true).status).toBe("published_dry_run");
  });

  it("reports real counts on a partial failure, not a status word alone", () => {
    // §5.12: "37 of 40 delivered, 3 failed", never a bare status.
    const result = rollUpDeliveries(tally({ sent: 37, failed: 3 }), false);
    expect(result.status).toBe("partially_delivered");
    expect(result.message).toContain("37 of 40 delivered");
    expect(result.message).toContain("3 failed");
  });

  it("does not claim to know more than it does when a send is unaccounted for", () => {
    // The case this test exists for. Two failed and one unknown is NOT the
    // same as three failed, and the message has to say so.
    const result = rollUpDeliveries(tally({ sent: 37, failed: 2, uncertain: 1 }), false);
    expect(result.status).toBe("partially_delivered");
    expect(result.message).toContain("37 of 40 delivered");
    expect(result.message).toContain("2 failed");
    expect(result.message).toContain("1 unknown");
    // And it must not describe the unknown one as a failure.
    expect(result.message).not.toMatch(/3 failed/);
  });

  it("never reports success while a send is unaccounted for", () => {
    // Everything that was attempted appears to have gone, EXCEPT one we cannot
    // account for. Calling that `published` would be the exact dishonesty §2.9
    // forbids.
    const result = rollUpDeliveries(tally({ sent: 39, uncertain: 1 }), false);
    expect(result.status).not.toBe("published");
    expect(result.status).not.toBe("published_dry_run");
    expect(result.message).toContain("1 unknown");
  });

  it("says an unknown delivery will not be retried, and why", () => {
    const result = rollUpDeliveries(tally({ sent: 10, uncertain: 2 }), false);
    expect(result.message).toMatch(/not be retried automatically/i);
    expect(result.message).toMatch(/same message twice/i);
  });

  it("says a failed delivery WILL be retried", () => {
    const result = rollUpDeliveries(tally({ sent: 10, failed: 2 }), false);
    expect(result.message).toMatch(/only to the ones that failed/i);
  });

  it("counts skipped recipients without treating them as attempts", () => {
    // §9c: a skipped recipient is recorded and counted, never a smaller
    // audience — but it was never attempted, so it is not a delivery failure.
    const result = rollUpDeliveries(tally({ sent: 37, skipped: 3 }), false);
    expect(result.status).toBe("published");
    expect(result.message).toContain("37 of 37 delivered");
    expect(result.message).toContain("3 skipped for consent");
  });

  it("fails clearly when everyone was skipped for consent", () => {
    const result = rollUpDeliveries(tally({ skipped: 5 }), false);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("all 5 recipients are not opted in");
    expect(result.needsAttention).toBe(true);
  });

  it("fails when there was nobody to send to", () => {
    const result = rollUpDeliveries(tally(), false);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("no recipients");
  });

  it("flags anything needing a person", () => {
    expect(rollUpDeliveries(tally({ sent: 40 }), false).needsAttention).toBe(false);
    expect(rollUpDeliveries(tally({ sent: 39, failed: 1 }), false).needsAttention).toBe(true);
    expect(rollUpDeliveries(tally({ sent: 39, uncertain: 1 }), false).needsAttention).toBe(true);
  });
});
