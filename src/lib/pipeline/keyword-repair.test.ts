import { describe, it, expect } from "vitest";
import { keywordFromHeadline } from "./planning";
import { containsKeyword } from "@/lib/text";

/**
 * A keyword that is not in its headline is repaired, not rejected.
 *
 * The model invents a phrase like "expectations gap", writes a good headline
 * that does not contain it, and fails its own constraint. That burned all
 * three planning attempts on two separate requests: three Haiku calls and 69
 * seconds to produce angles that were fine.
 *
 * The keyword is derived data. The headline is what a reader sees, so the
 * headline wins and the keyword comes out of it.
 */

describe("keywordFromHeadline", () => {
  it("repairs the case that burned three planning attempts", () => {
    const headline = "Why applicants are rejecting offers faster than you can extend them.";
    const repaired = keywordFromHeadline(headline, "expectations gap");

    expect(repaired).not.toBeNull();
    // Whatever it picks must satisfy the check that rejected the original.
    expect(containsKeyword(headline, repaired!)).toBe(true);
  });

  it("prefers a phrase that overlaps what the model intended", () => {
    const headline = "Hiring bottlenecks cost you weeks before candidates apply";
    const repaired = keywordFromHeadline(headline, "hiring delays");

    expect(repaired).toContain("hiring");
    expect(containsKeyword(headline, repaired!)).toBe(true);
  });

  it("never returns a phrase the headline does not contain", () => {
    const headlines = [
      "Five ways to reduce time-to-hire without lowering your bar",
      "What structured interviews actually predict",
      "The cost of a vague remote interview process",
    ];

    for (const headline of headlines) {
      const repaired = keywordFromHeadline(headline, "something unrelated entirely");
      if (repaired !== null) {
        expect(containsKeyword(headline, repaired)).toBe(true);
      }
    }
  });

  it("skips stop words rather than returning 'why your'", () => {
    const repaired = keywordFromHeadline("Why your time-to-hire keeps slipping", "process drag");
    expect(repaired).not.toBeNull();
    expect(repaired).not.toMatch(/^(why|your|the|a)\b/);
  });

  it("returns null when there is nothing usable", () => {
    // Nothing but stop words: there is no keyword to take.
    expect(keywordFromHeadline("Why is it that they are", "anything")).toBeNull();
  });

  it("leaves a headline that already matches alone", () => {
    // The caller only repairs when the check FAILS, but the extraction should
    // still produce something valid here.
    const headline = "Remote hiring transparency changes who accepts your offer";
    const repaired = keywordFromHeadline(headline, "remote hiring transparency");
    expect(containsKeyword(headline, repaired!)).toBe(true);
  });
});
