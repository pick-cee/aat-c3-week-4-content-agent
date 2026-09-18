import { describe, expect, it } from "vitest";
import { channelRevisionPrompt, channelRevisionSourceIssues } from "./channel-revision";
import type { ArticleVersion, ChannelOutput } from "@/lib/db/types";

const article = { body_md: "Eighty-four percent report delays. [E1]\nRead [the research](https://example.com/research)." } as ArticleVersion;
describe("revising a channel against its article", () => {
  it("includes the existing copy, specific edit and format failures without making them factual sources", () => {
    const previous = { subject: "Hiring", body: "Keep this section.", hashtags: [], format_check: { checks: [{ passed: false, detail: "No sign-off was found at the end." }] } } as unknown as ChannelOutput;
    const prompt = channelRevisionPrompt(previous, "Only add a friendly sign-off.");
    expect(prompt).toContain("Keep this section.");
    expect(prompt).toContain("Only add a friendly sign-off.");
    expect(prompt).toContain("No sign-off was found at the end.");
    expect(prompt).toContain("sole factual authority");
    expect(prompt).toContain("Preserve unrelated sections");
  });
  it("rejects an invented figure even when it carries a valid marker", () => {
    expect(channelRevisionSourceIssues("95% report delays. [E1]", article, null)).toEqual(["The figure 95% is absent from the article."]);
  });
  it("allows equivalent written figures, list positions and the approved article link", () => {
    expect(channelRevisionSourceIssues("1. 84% report delays. [E1] https://studio.test/a/2026", article, "https://studio.test/a/2026")).toEqual([]);
  });
  it("rejects a link supplied by an editor when the article does not contain it", () => {
    expect(channelRevisionSourceIssues("Read https://invented.example/survey", article, null)).toHaveLength(1);
  });
});
