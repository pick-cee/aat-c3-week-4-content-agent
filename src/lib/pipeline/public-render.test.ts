import { describe, it, expect } from "vitest";
import { stripInternalMarkupForTest as strip } from "@/components/article-view";

/**
 * The public permalink must never print the pipeline's machinery.
 *
 * `showCitations={false}` suppressed only the superscript badge, so the
 * sentence text still carried its raw markers and a reader following a shared
 * link saw:
 *
 *   [E13]
 *   ((link: Interview scorecard templates E14))
 *   A consistent ((link: interview notes E8)) framework...
 *
 * Markers stay in storage, because every grounding check depends on them.
 * They are removed at render.
 */

describe("stripInternalMarkup", () => {
  it("removes a citation marker", () => {
    expect(strip("Hiring improved sharply. [E13]")).toBe("Hiring improved sharply.");
  });

  it("removes a multi-label marker", () => {
    expect(strip("Two studies agreed. [E3, E17]")).toBe("Two studies agreed.");
  });

  it("keeps the anchor text of a link marker", () => {
    // The anchor is words the writer meant to appear. Dropping the whole
    // marker would delete them and leave the sentence ungrammatical.
    expect(strip("((link: Interview scorecard templates | E14)) exist for this.")).toBe(
      "Interview scorecard templates exist for this.",
    );
  });

  it("handles a link marker missing its pipe", () => {
    // Exactly what appeared on the public page.
    expect(strip("((link: Interview scorecard templates E14))")).toBe(
      "Interview scorecard templates E14",
    );
  });

  it("keeps a link anchor mid-sentence", () => {
    const input =
      "A consistent ((link: interview notes | E8)) framework, a rubric built before " +
      "interviews start, and scores locked in cover most of it.";
    expect(strip(input)).toBe(
      "A consistent interview notes framework, a rubric built before interviews start, " +
        "and scores locked in cover most of it.",
    );
  });

  it("does not leave a space before punctuation", () => {
    // "sharply [E1]." would otherwise become "sharply ."
    expect(strip("Hiring improved sharply [E1].")).toBe("Hiring improved sharply.");
  });

  it("leaves a clean sentence untouched", () => {
    const text = "Structured interviews use the same questions for every candidate.";
    expect(strip(text)).toBe(text);
  });

  it("leaves real markdown links alone", () => {
    const text = "See [the study](https://example.com/study) for the detail.";
    expect(strip(text)).toBe(text);
  });

  it("clears every marker from a realistic paragraph", () => {
    const input =
      "Unstructured interviews carry a validity of .38. [E3] Structured ones reach .51. " +
      "[E3, E7] ((link: scorecard templates | E14)) make this repeatable.";
    const out = strip(input);
    expect(out).not.toMatch(/\[E\d/);
    expect(out).not.toContain("((link:");
    expect(out).toContain("scorecard templates make this repeatable.");
  });
});
