import { describe, it, expect } from "vitest";
import { selectPendingSources, type EmbedCandidate } from "./research";
import { MAX_EMBED_ATTEMPTS } from "@/lib/constants";

/**
 * The rule that decides whether a source gets another chance at indexing.
 *
 * This existed inline as `!done.has(s.id) && !s.embed_failed`, which excluded
 * every failed source permanently. Six articles of 20k-36k characters were
 * fetched, refused once by the embedding provider's per-minute rate limit, and
 * then skipped on every subsequent attempt — retrying the request could not
 * recover them. Two sources survived, "two sources per angle" became
 * unsatisfiable, and the symptom the manager saw three steps later was "these
 * angles are too similar".
 */

function source(over: Partial<EmbedCandidate> & { id: string }): EmbedCandidate {
  return {
    embed_failed: false,
    embed_retryable: false,
    embed_attempts: 0,
    ...over,
  };
}

describe("selectPendingSources", () => {
  it("includes a source that has never been attempted", () => {
    const pending = selectPendingSources([source({ id: "a" })], new Set());
    expect(pending.map((s) => s.id)).toEqual(["a"]);
  });

  it("skips a source that already has excerpts", () => {
    const pending = selectPendingSources([source({ id: "a" })], new Set(["a"]));
    expect(pending).toEqual([]);
  });

  it("retries a source whose failure was transient", () => {
    // The 429 case: the page is fine, the minute was not.
    const rateLimited = source({
      id: "a",
      embed_failed: true,
      embed_retryable: true,
      embed_attempts: 1,
    });
    const pending = selectPendingSources([rateLimited], new Set());
    expect(pending.map((s) => s.id)).toEqual(["a"]);
  });

  it("does not retry a permanent failure", () => {
    // A page that produced no chunks will not produce chunks later.
    const empty = source({
      id: "a",
      embed_failed: true,
      embed_retryable: false,
      embed_attempts: 1,
    });
    expect(selectPendingSources([empty], new Set())).toEqual([]);
  });

  it("stops retrying once the attempt cap is reached", () => {
    // Otherwise a provider that is down for the whole run spends every step
    // invocation on the same source while the others wait.
    const exhausted = source({
      id: "a",
      embed_failed: true,
      embed_retryable: true,
      embed_attempts: MAX_EMBED_ATTEMPTS,
    });
    expect(selectPendingSources([exhausted], new Set())).toEqual([]);
  });

  it("attempts untried sources before ones already being retried", () => {
    const retrying = source({
      id: "retrying",
      embed_failed: true,
      embed_retryable: true,
      embed_attempts: 2,
    });
    const fresh = source({ id: "fresh" });

    const pending = selectPendingSources([retrying, fresh], new Set());
    expect(pending.map((s) => s.id)).toEqual(["fresh", "retrying"]);
  });

  it("recovers the whole corpus once the rate limit clears", () => {
    // The actual failure, reproduced: nine readable sources, six refused by a
    // per-minute quota. The old rule left two usable; this one leaves none
    // behind.
    const candidates = [
      source({ id: "s1" }),
      source({ id: "s2" }),
      source({ id: "s3" }),
      ...Array.from({ length: 6 }, (_, i) =>
        source({
          id: `rl${i}`,
          embed_failed: true,
          embed_retryable: true,
          embed_attempts: 1,
        }),
      ),
    ];

    const indexed = new Set(["s2", "s3"]);
    const pending = selectPendingSources(candidates, indexed);

    expect(pending).toHaveLength(7);
    expect(pending.filter((s) => s.embed_failed)).toHaveLength(6);
  });
});
