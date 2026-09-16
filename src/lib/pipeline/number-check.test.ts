import { describe, it, expect } from "vitest";
import { extractSignificantNumbersForTest, citedTextStatesNumberForTest } from "./evaluation";

/**
 * The figure check that sent a good article to `needs_human` twice.
 *
 * It reported two "disagreements" and neither was real:
 *
 *   1. "predictive validity of just.38" — stripMarkdown had eaten the leading
 *      zero, the extractor captured "38," WITH the comma, and then searched
 *      the excerpt for that literal string. It could never match.
 *   2. "((link: Interview scorecard templates E14))" — "14" was pulled out of
 *      an excerpt LABEL and reported as a figure disagreeing with its source.
 *      There was no figure to correct, so no revision could fix it.
 *
 * The article was fine. The checker was manufacturing failures, and every
 * revision round was spent chasing them.
 */

describe("extractSignificantNumbers", () => {
  it("does not take a number out of a link marker", () => {
    // The exact sentence from the failing request.
    const sentence =
      "((link: Interview scorecard templates | E14)) exist precisely to make this step " +
      "easier to standardize across a panel.";
    expect(extractSignificantNumbersForTest(sentence)).toEqual([]);
  });

  it("does not take a number out of a citation marker", () => {
    expect(extractSignificantNumbersForTest("Hiring improved sharply. [E12]")).toEqual([]);
    expect(extractSignificantNumbersForTest("Two studies agreed. [E3, E17]")).toEqual([]);
  });

  it("drops trailing punctuation from a figure", () => {
    // "38," and "51." are the value plus a comma or full stop.
    const numbers = extractSignificantNumbersForTest(
      "Unstructured interviews carry a validity of just .38, while structured reach .51.",
    );
    expect(numbers).toContain(".38");
    expect(numbers).toContain(".51");
    expect(numbers.some((n) => n.endsWith(",") || n.endsWith("."))).toBe(false);
  });

  it("still finds the figures that matter", () => {
    const numbers = extractSignificantNumbersForTest("Churn rose 26% across 4,312 hires.");
    expect(numbers).toContain("26%");
    expect(numbers).toContain("4,312");
  });

  it("ignores a small count in the writer's own argument", () => {
    // "three things" is not a claim about the world.
    expect(extractSignificantNumbersForTest("There are 3 steps to this.")).toEqual([]);
  });
});

describe("citedTextStatesNumber", () => {
  it("matches a figure written identically", () => {
    expect(citedTextStatesNumberForTest("churn was 26% last year", "26%")).toBe(true);
  });

  it("matches 0.38 against a source that writes .38", () => {
    // The leading zero is a typographic choice, not a different number.
    expect(citedTextStatesNumberForTest("validity of .38 for unstructured", "0.38")).toBe(true);
  });

  it("matches a thousands separator written either way", () => {
    expect(citedTextStatesNumberForTest("4312 candidates applied", "4,312")).toBe(true);
    expect(citedTextStatesNumberForTest("4,312 candidates applied", "4312")).toBe(true);
  });

  it("matches a percentage against the bare number", () => {
    expect(citedTextStatesNumberForTest("38 percent of interviews", "38%")).toBe(true);
  });

  it("still catches a figure that genuinely is not there", () => {
    // The whole point of the check survives: a made-up number fails.
    expect(citedTextStatesNumberForTest("churn was 26% last year", "73%")).toBe(false);
  });
});
