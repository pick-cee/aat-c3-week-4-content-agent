import { describe, it, expect } from "vitest";
import {
  runSeoChecks,
  checkLinkedIn,
  checkX,
  checkNewsletter,
  findBannedPhrases,
} from "./checks";

/**
 * The cases in DESIGN.md §21.1's "deliberately broken input pack" that these
 * checks are responsible for catching.
 */

describe("runSeoChecks", () => {
  const goodArticle = [
    "# Remote Hiring in Nigeria: What Actually Works",
    "",
    "Remote hiring in Nigeria has changed twice over. Teams that adapted early are ahead.",
    "",
    "## Where teams get stuck",
    "",
    "Most teams underestimate onboarding. See [the original study](https://a.example/x) for detail.",
    "",
    "## What to do instead",
    "",
    "Start with a written brief. It saves weeks. More in [the follow-up](https://b.example/y).",
    "",
    "## How to measure it",
    "",
    "Track time to first contribution. It is the only number that matters early.",
  ].join("\n");

  const base = {
    title: "Remote Hiring in Nigeria: What Actually Works",
    metaDescription: "A practical guide to remote hiring in Nigeria.",
    bodyMd: goodArticle,
    primaryKeyword: "remote hiring",
    secondaryKeywords: ["onboarding"],
    outline: [
      { heading: "Where teams get stuck", intent: "" },
      { heading: "What to do instead", intent: "" },
      { heading: "How to measure it", intent: "" },
    ],
    allowedUrls: ["https://a.example/x", "https://b.example/y"],
  };

  it("passes a well-formed article", () => {
    const result = runSeoChecks(base);
    expect(result.keywordInTitle).toBe(true);
    expect(result.keywordInFirst100).toBe(true);
    expect(result.exactlyOneH1).toBe(true);
    expect(result.linkCount).toBe(2);
    expect(result.linksResolve).toBe(true);
    expect(result.missingSections).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails when the keyword is missing from the title", () => {
    const result = runSeoChecks({ ...base, title: "A Guide To Getting Started" });
    expect(result.keywordInTitle).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("catches a link that does not resolve to a selected source", () => {
    // The model never writes a URL (rule 3), so this means substitution failed.
    const result = runSeoChecks({
      ...base,
      bodyMd: goodArticle.replace("https://b.example/y", "https://invented.example/z"),
    });
    expect(result.linksResolve).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("reports a missing outline section as a Completeness failure", () => {
    // §17: "A missing outline section is a Completeness failure, not a
    // shorter article."
    const result = runSeoChecks({
      ...base,
      outline: [...base.outline, { heading: "A section never written", intent: "" }],
    });
    expect(result.missingSections).toEqual(["A section never written"]);
    expect(result.passed).toBe(false);
  });

  it("counts more than one H1 as a failure", () => {
    const result = runSeoChecks({ ...base, bodyMd: `${goodArticle}\n\n# A second H1` });
    expect(result.exactlyOneH1).toBe(false);
  });
});

describe("checkLinkedIn", () => {
  const pas = {
    problem: "Most teams cannot hire remotely without losing weeks.",
    agitation: "Every week lost is a role unfilled and a project slipping.",
    solution: "A written brief and a two-stage process fixes it.",
  };
  const body = `${pas.problem}\n\n${pas.agitation}\n\n${pas.solution}\n\nRead the full breakdown.`;

  it("passes a well-formed post", () => {
    const result = checkLinkedIn({
      body,
      cta: "Read the full breakdown",
      pas,
      emojiAllowance: 3,
    });
    expect(result.passed).toBe(true);
  });

  it("fails a 3000-character post", () => {
    // §21.1: "A 3,000-character LinkedIn post → format failure, one retry,
    // then format_failed on that channel only."
    const result = checkLinkedIn({
      body: "x".repeat(3_001),
      cta: "Read it",
      pas: null,
      emojiAllowance: 3,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name.includes("3000"))!.passed).toBe(false);
  });

  it("fails when the PAS spans are out of order", () => {
    const scrambled = `${pas.solution}\n\n${pas.problem}\n\n${pas.agitation}\n\nRead the full breakdown.`;
    const result = checkLinkedIn({
      body: scrambled,
      cta: "Read the full breakdown",
      pas,
      emojiAllowance: 3,
    });
    expect(result.checks.find((c) => c.name.includes("order"))!.passed).toBe(false);
  });

  it("fails when emoji exceed the brand voice allowance", () => {
    const result = checkLinkedIn({
      body: `${body} 🎉🎉🎉🎉`,
      cta: "Read the full breakdown",
      pas,
      emojiAllowance: 2,
    });
    expect(result.checks.find((c) => c.name.includes("Emoji"))!.passed).toBe(false);
  });
});

describe("checkX", () => {
  it("passes a well-formed post", () => {
    const result = checkX({
      body: "Remote hiring breaks at onboarding.\n\nHere is the fix. #hiring",
      hashtags: ["#hiring"],
      coreIdea: "Onboarding is where remote hiring breaks",
      includesLink: false,
    });
    expect(result.passed).toBe(true);
  });

  it("catches a post that only exceeds 280 once the link is counted", () => {
    // §21.1, and the reason the counter is a tested function rather than
    // String.length.
    const body = `${"x".repeat(262)}\n\nhttps://koya.example/a/post`;
    const result = checkX({
      body,
      hashtags: ["#hiring"],
      coreIdea: "An idea",
      includesLink: true,
    });
    const limitCheck = result.checks.find((c) => c.name.includes("280"))!;
    expect(limitCheck.passed).toBe(false);
    expect(limitCheck.detail).toContain("23");
  });

  it("passes a long URL that raw length would wrongly reject", () => {
    const body = `${"y".repeat(200)}\n\nhttps://example.com/${"z".repeat(120)}`;
    expect(body.length).toBeGreaterThan(280);
    const result = checkX({
      body,
      hashtags: ["#a"],
      coreIdea: "An idea",
      includesLink: true,
    });
    expect(result.checks.find((c) => c.name.includes("280"))!.passed).toBe(true);
  });

  it("fails on three hashtags", () => {
    const result = checkX({
      body: "Short post.\n\n#a #b #c",
      hashtags: ["#a", "#b", "#c"],
      coreIdea: "An idea",
      includesLink: false,
    });
    expect(result.checks.find((c) => c.name.includes("hashtag"))!.passed).toBe(false);
  });
});

describe("checkNewsletter", () => {
  const body = [
    "Hiring remotely is harder than it looks. Here is what changed this year.",
    "",
    "## What actually broke",
    "",
    `${"Teams lost weeks to unclear briefs and slow feedback loops. ".repeat(20)}`,
    "",
    "## What to do about it",
    "",
    `${"Write the brief first and keep the loop short. ".repeat(20)}`,
    "",
    "Read the full breakdown on the site.",
    "",
    "Cheers,",
    "The Koya team",
  ].join("\n");

  it("passes a well-formed newsletter", () => {
    const result = checkNewsletter({
      subject: "What broke in remote hiring this year",
      body,
      cta: "Read the full breakdown",
    });
    expect(result.passed).toBe(true);
  });

  it("names the actual word count when outside the band", () => {
    // §12.1: a hard failure with one retry naming the actual count, because a
    // model told the real number usually fixes it.
    const result = checkNewsletter({
      subject: "Short",
      body: "Too short to be a newsletter.",
      cta: "Read it",
    });
    const wordCheck = result.checks.find((c) => c.name.includes("250"))!;
    expect(wordCheck.passed).toBe(false);
    expect(wordCheck.detail).toMatch(/is \d+ words/);
  });

  it("accepts a sign-off that is not a conventional opener", () => {
    // A real failure: "Cleaning on your terms,\nKoya Talent" was rejected
    // twice because the check matched a fixed list of words rather than the
    // SHAPE of a sign-off, so a good newsletter was marked format_failed.
    const custom = body.replace("Cheers,\nThe Koya team", "Cleaning on your terms,\nKoya Talent");
    const result = checkNewsletter({
      subject: "What broke in remote hiring this year",
      body: custom,
      cta: "Read the full breakdown",
    });
    expect(result.checks.find((c) => c.name.includes("sign-off"))!.passed).toBe(true);
  });

  it("accepts an em-dash sign-off", () => {
    const dashed = body.replace("Cheers,\nThe Koya team", "— The Koya team");
    const result = checkNewsletter({
      subject: "Subject",
      body: dashed,
      cta: "Read it",
    });
    expect(result.checks.find((c) => c.name.includes("sign-off"))!.passed).toBe(true);
  });

  it("still fails when the newsletter just stops", () => {
    const abrupt = body.replace("Cheers,\nThe Koya team", "");
    const result = checkNewsletter({ subject: "Subject", body: abrupt, cta: "Read it" });
    expect(result.checks.find((c) => c.name.includes("sign-off"))!.passed).toBe(false);
  });

  it("fails a subject line over 65 characters", () => {
    const result = checkNewsletter({
      subject: "x".repeat(66),
      body,
      cta: "Read it",
    });
    expect(result.checks.find((c) => c.name.includes("Subject"))!.passed).toBe(false);
  });
});

describe("findBannedPhrases", () => {
  it("finds a banned phrase regardless of case", () => {
    expect(findBannedPhrases("This is a Game-Changer for teams", ["game-changer"])).toEqual([
      "game-changer",
    ]);
  });

  it("returns empty when the copy is clean", () => {
    expect(findBannedPhrases("A plain sentence.", ["game-changer"])).toEqual([]);
  });
});
