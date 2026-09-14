import { describe, it, expect } from "vitest";
import {
  segmentSentences,
  countXCharacters,
  canonicaliseUrl,
  containsKeyword,
  countWords,
  parseHeadings,
  parseParagraphs,
  slugify,
  isValidE164,
  normaliseE164,
  registrableDomain,
  describeBytes,
  extractMarkdownLinks,
} from "./text";

/**
 * These cover the cases DESIGN.md names explicitly — the ones that produced
 * real bugs and are therefore worth a test rather than a comment.
 */

describe("segmentSentences", () => {
  it("does not split on the decimal point in a percentage", () => {
    // §10: a hand-rolled split on "." would break on "2.5%" and corrupt the
    // claim map silently, which is the worst kind of bug this system can have.
    const sentences = segmentSentences("Conversions rose 2.5% last quarter. That is real.");
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.text).toBe("Conversions rose 2.5% last quarter.");
  });

  it("does not split on an abbreviation", () => {
    const sentences = segmentSentences("Acme Inc. raised a round. Nobody expected it.");
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.text).toContain("Inc.");
  });

  it("indexes sentences contiguously, which the claim map keys on", () => {
    const sentences = segmentSentences("One. Two. Three.");
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("ignores whitespace-only segments", () => {
    expect(segmentSentences("  \n\n  ")).toHaveLength(0);
  });
});

describe("countXCharacters", () => {
  it("weighs any URL at 23 regardless of real length", () => {
    const short = countXCharacters("See https://a.co");
    const long = countXCharacters(
      "See https://example.com/a/very/long/path?with=query&more=params#and-a-fragment",
    );
    expect(short).toBe(long);
    expect(short).toBe("See ".length + 23);
  });

  it("catches a post that only goes over 280 once the link is counted", () => {
    // §21.1, a named case in the broken-input pack. The body is under the
    // limit; the link is what breaks it.
    const body = "x".repeat(262);
    expect(body.length).toBeLessThan(280);
    const withLink = `${body} https://koya.example/a/post`;
    expect(withLink.length).toBeGreaterThan(280); // raw length also over, but:
    expect(countXCharacters(withLink)).toBe(262 + 1 + 23);
    expect(countXCharacters(withLink)).toBeGreaterThan(280);
  });

  it("passes a post that raw .length would wrongly reject", () => {
    // The inverse failure: a long URL makes String.length overcount, so a
    // perfectly valid post looks too long.
    const body = "y".repeat(200);
    const longUrl = `https://example.com/${"z".repeat(120)}`;
    const post = `${body} ${longUrl}`;
    expect(post.length).toBeGreaterThan(280);
    expect(countXCharacters(post)).toBe(200 + 1 + 23);
    expect(countXCharacters(post)).toBeLessThanOrEqual(280);
  });

  it("weighs an emoji at 2, not at its surrogate pair length", () => {
    expect(countXCharacters("🎉")).toBe(2);
    expect("🎉".length).toBe(2); // coincidence in UTF-16; the next case is not
    expect(countXCharacters("👨‍👩‍👧")).toBeGreaterThan(2);
  });

  it("weighs CJK at 2", () => {
    expect(countXCharacters("日本語")).toBe(6);
  });

  it("counts plain ASCII at 1", () => {
    expect(countXCharacters("hello world")).toBe(11);
  });
});

describe("canonicaliseUrl", () => {
  it("collapses the same article at two URLs with tracking params", () => {
    // §21.1: "The same article at two URLs with tracking params → one source".
    const a = canonicaliseUrl("https://www.Example.com/post/?utm_source=twitter&utm_medium=social");
    const b = canonicaliseUrl("https://example.com/post#section-2");
    expect(a).toBe(b);
  });

  it("strips utm_ variants not in the fixed list", () => {
    expect(canonicaliseUrl("https://example.com/x?utm_custom_thing=1")).toBe(
      "https://example.com/x",
    );
  });

  it("keeps meaningful query params", () => {
    expect(canonicaliseUrl("https://example.com/search?q=hiring&page=2")).toContain("q=hiring");
  });

  it("drops a default port", () => {
    expect(canonicaliseUrl("https://example.com:443/a")).toBe("https://example.com/a");
  });
});

describe("containsKeyword", () => {
  it("matches case-insensitively", () => {
    expect(containsKeyword("Remote Hiring In Africa", "remote hiring")).toBe(true);
  });

  it("matches across a plural", () => {
    expect(containsKeyword("Advice for content marketers", "content marketing")).toBe(true);
  });

  it("does not match an unrelated phrase", () => {
    expect(containsKeyword("A post about databases", "content marketing")).toBe(false);
  });

  it("tolerates punctuation between the words", () => {
    expect(containsKeyword("Remote-hiring, done well", "remote hiring")).toBe(true);
  });
});

describe("markdown parsing", () => {
  const doc = [
    "# The Title",
    "",
    "Opening paragraph here. It has two sentences.",
    "",
    "## First Section",
    "",
    "- a bullet",
    "- another",
    "",
    "Another paragraph.",
    "",
    "```",
    "# not a heading, it is code",
    "```",
    "",
    "### A Subheading",
  ].join("\n");

  it("reads the heading tree and ignores fenced code", () => {
    const headings = parseHeadings(doc);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(headings[0]!.text).toBe("The Title");
  });

  it("counts only prose blocks as paragraphs", () => {
    const paragraphs = parseParagraphs(doc);
    expect(paragraphs).toHaveLength(2);
  });

  it("counts words without markdown punctuation", () => {
    expect(countWords("**bold** and _italic_ words")).toBe(4);
  });

  it("extracts links but not images", () => {
    const links = extractMarkdownLinks("See [here](https://a.co) and ![alt](https://img.co/x.png)");
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe("https://a.co");
  });
});

describe("slugify", () => {
  it("produces a clean permalink segment", () => {
    expect(slugify("How to Hire Remotely in Nigeria: A Guide")).toBe(
      "how-to-hire-remotely-in-nigeria-a-guide",
    );
  });

  it("never ends in a hyphen after truncation", () => {
    expect(slugify("a ".repeat(100))).not.toMatch(/-$/);
  });
});

describe("E.164", () => {
  it("accepts a valid Nigerian number", () => {
    expect(isValidE164("+2348012345678")).toBe(true);
  });

  it("rejects a number without a plus", () => {
    expect(isValidE164("2348012345678")).toBe(false);
  });

  it("normalises common formatting", () => {
    expect(normaliseE164("+234 801 234 5678")).toBe("+2348012345678");
    expect(normaliseE164("(234) 801-234-5678")).toBe("+2348012345678");
  });

  it("returns null rather than a plausible wrong number", () => {
    expect(normaliseE164("not a phone")).toBeNull();
  });
});

describe("registrableDomain", () => {
  it("handles a two-level TLD", () => {
    expect(registrableDomain("https://news.example.co.uk/a")).toBe("example.co.uk");
    expect(registrableDomain("https://blog.example.com.ng/a")).toBe("example.com.ng");
  });

  it("treats a subdomain as the same registrable domain", () => {
    expect(registrableDomain("https://blog.example.com/a")).toBe(
      registrableDomain("https://example.com/b"),
    );
  });
});

describe("describeBytes", () => {
  it("makes the invisible characters visible", () => {
    // The diagnostic DESIGN.md's Conventions section demands: "an invisible
    // character on a string cost hours once already".
    expect(describeBytes("a b")).toBe("a[NBSP]b");
    expect(describeBytes("a​b")).toBe("a[U+200B]b");
    expect(describeBytes("line\nnext")).toBe("line\\nnext");
    expect(describeBytes("tab\there")).toBe("tab\\there");
  });
});
