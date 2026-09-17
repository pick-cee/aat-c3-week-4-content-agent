import { describe, expect, it } from "vitest";
import { applyRevisionPatch, articleSections, OPENING_SECTION } from "./revision-patch";

const original = "# Title\n\nOld opening. [E1]\n\n## One\n\nKeep this. [E1]\n\n## Two\n\nOld detail. [E2]";
describe("bounded article revisions", () => {
  it("can repair the title and introduction while preserving other sections", () => {
    const result = applyRevisionPatch(original, { sections: [{ heading: OPENING_SECTION, markdown: "# Better title\n\nSupported opening. [E1]" }] }, [OPENING_SECTION], 3);
    expect(result).toContain("# Better title");
    expect(result.slice(result.indexOf("## One"))).toBe(original.slice(original.indexOf("## One")));
  });
  it("adds a missing approved outline section", () => {
    expect(applyRevisionPatch(original, { sections: [{ heading: "Three", markdown: "## Three\n\nNew detail. [E2]" }] }, ["Three"], 3)).toContain("## Three");
  });
  it.each([
    { heading: "One", markdown: "## One\nChanged\n## Two\nHidden rewrite" },
    { heading: "Unapproved", markdown: "## Unapproved\nNew" },
    { heading: OPENING_SECTION, markdown: "No title" },
  ])("rejects changes outside their section", section => {
    expect(() => applyRevisionPatch(original, { sections: [section] }, ["One", OPENING_SECTION], 3)).toThrow();
  });
  it("does not interpret code examples as article headings", () => {
    expect(articleSections("# T\n\n## One\n```md\n## Example\n```\nText")).toHaveLength(2);
  });
});
