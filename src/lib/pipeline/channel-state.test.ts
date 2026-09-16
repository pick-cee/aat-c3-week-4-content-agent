import { describe, it, expect } from "vitest";
import { deriveChannelState, summariseChannels } from "./channel-state";

/**
 * Each channel tells its own story.
 *
 * The dashboard rendered the REQUEST's status plus three neutral channel
 * chips, so a request whose newsletter had published, whose LinkedIn had been
 * cancelled and whose X post had been rejected read "Scheduled" with three
 * identical grey chips. Every chip was wrong about its channel and the status
 * word was wrong about all three.
 */

describe("deriveChannelState", () => {
  it("reports a published channel as sent", () => {
    const state = deriveChannelState("newsletter", "approved", "published");
    expect(state.detail).toBe("sent");
    expect(state.tone).toBe("ok");
  });

  it("reports a cancelled channel as cancelled, not scheduled", () => {
    const state = deriveChannelState("linkedin", "approved", "cancelled");
    expect(state.detail).toBe("cancelled");
  });

  it("reports a rejected channel from its output when it never reached the queue", () => {
    const state = deriveChannelState("x", "rejected", null);
    expect(state.detail).toBe("rejected");
  });

  it("prefers the queue row over the output status", () => {
    // The output says approved; the queue says it failed. What the worker did
    // is what happened.
    const state = deriveChannelState("newsletter", "approved", "failed");
    expect(state.detail).toBe("failed");
    expect(state.tone).toBe("danger");
  });

  it("never calls a handoff channel sent until a person confirms", () => {
    const waiting = deriveChannelState("linkedin", "approved", "awaiting_manual_post");
    expect(waiting.detail).toBe("for you to post");

    const done = deriveChannelState("linkedin", "approved", "posted_manually");
    expect(done.detail).toBe("posted");
  });

  it("marks a dry run as a dry run rather than a real send", () => {
    // DEMO_MODE must never look like a real publish (§19.6).
    expect(deriveChannelState("newsletter", "approved", "published_dry_run").detail).toBe(
      "dry run",
    );
  });

  it("flags an unknown outcome as the worst news", () => {
    const unknown = deriveChannelState("newsletter", "approved", "uncertain");
    expect(unknown.tone).toBe("danger");
    // Weight 0 sorts it above everything else.
    expect(unknown.weight).toBe(0);
  });

  it("says a channel still needs review when it is only a draft", () => {
    expect(deriveChannelState("x", "draft", null).detail).toBe("needs review");
  });

  it("does not claim anything when no output exists yet", () => {
    expect(deriveChannelState("x", null, null).detail).toBe("not ready");
  });
});

describe("summariseChannels", () => {
  it("describes the exact smoke test that exposed this", () => {
    // Newsletter sent, LinkedIn cancelled, X rejected: the dashboard said
    // "Scheduled".
    const states = [
      deriveChannelState("newsletter", "approved", "published"),
      deriveChannelState("linkedin", "approved", "cancelled"),
      deriveChannelState("x", "rejected", null),
    ];
    expect(summariseChannels(states)).toBe("1 sent, 1 cancelled, 1 rejected");
  });

  it("groups channels that share an outcome", () => {
    const states = [
      deriveChannelState("newsletter", "approved", "published"),
      deriveChannelState("linkedin", "approved", "posted_manually"),
    ];
    // Different words for different mechanisms, counted separately.
    expect(summariseChannels(states)).toBe("1 sent, 1 posted");
  });

  it("says something honest with no channels", () => {
    expect(summariseChannels([])).toBe("No channels");
  });
});
