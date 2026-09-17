import { describe, expect, it } from "vitest";
import { preserveRevisionLinks } from "./revision-links";
import { extractMarkdownLinks } from "@/lib/text";
const url = "https://source.example/study";
const before = `# Title\n\nOpening.\n\n## Evidence\n\nRead [the study](${url}) and [the guide](${url}).\n\n## Conclusion\n\nKeep this unchanged.`;
describe("revision reference preservation", () => {
  it("restores dropped verified references within their original section", () => {
    const revised = "# Title\n\nOpening.\n\n## Evidence\n\nA clearer supported explanation.\n\n## Conclusion\n\nKeep this unchanged.";
    const result = preserveRevisionLinks(before, revised, [url]);
    expect(extractMarkdownLinks(result)).toHaveLength(2);
    expect(result.split("## Conclusion")[1]).toBe(revised.split("## Conclusion")[1]);
  });
  it("does not restore unapproved URLs or add extra links when the rewrite already has enough", () => {
    expect(preserveRevisionLinks(before, "# Title\n\n## Evidence\n\nText.", [])).not.toContain(url);
    expect(preserveRevisionLinks(before, before, [url])).toBe(before);
  });
});
