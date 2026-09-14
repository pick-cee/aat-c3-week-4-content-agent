import { describe, it, expect } from "vitest";
import {
  extractMarkers,
  checkMarkerIntegrity,
  runTripwire,
  checkInheritedMarkers,
  segmentSentencesWithMarkers,
  stripMarkers,
  resolveLinks,
  renderExcerptsForPrompt,
  type LabelledExcerpt,
} from "./grounding";
import { chunkMarkdown } from "./chunking";

function excerpt(label: string, text: string, overrides: Partial<LabelledExcerpt> = {}): LabelledExcerpt {
  return {
    label,
    excerptId: `uuid-${label}`,
    sourceId: `src-${label}`,
    sourceLabel: "S1",
    text,
    headingPath: null,
    sourceTitle: "A page",
    sourceUrl: "https://example.com/a",
    siteName: "example.com",
    publishedAt: null,
    embedding: null,
    ...overrides,
  };
}

describe("extractMarkers", () => {
  it("reads a single marker", () => {
    expect(extractMarkers("A claim. [E12]")).toEqual(["E12"]);
  });

  it("reads several markers in one bracket", () => {
    expect(extractMarkers("A claim. [E1, E2]")).toEqual(["E1", "E2"]);
  });

  it("reads markers across a body", () => {
    expect(extractMarkers("One. [E1] Two. [E3]")).toEqual(["E1", "E3"]);
  });

  it("ignores bracketed text that is not a marker", () => {
    expect(extractMarkers("See [the docs](https://a.co) and [note].")).toEqual([]);
  });
});

describe("checkMarkerIntegrity", () => {
  const supplied = [excerpt("E1", "first"), excerpt("E2", "second")];

  it("passes when every marker was supplied", () => {
    const result = checkMarkerIntegrity("Claim one. [E1] Claim two. [E2]", supplied);
    expect(result.valid).toBe(true);
    expect(result.unknownLabels).toEqual([]);
  });

  it("hard-fails on a marker for a non-existent excerpt", () => {
    // §21.1: "A draft with a citation marker for a non-existent excerpt →
    // hard fail, retry, second fail stops the request."
    const result = checkMarkerIntegrity("Claim. [E1] Invented. [E99]", supplied);
    expect(result.valid).toBe(false);
    expect(result.unknownLabels).toEqual(["E99"]);
  });

  it("reports each unknown label once, so a retry prompt is not repetitive", () => {
    const result = checkMarkerIntegrity("A. [E99] B. [E99] C. [E98]", supplied);
    expect(result.unknownLabels).toEqual(["E99", "E98"]);
  });
});

describe("runTripwire", () => {
  const known = ["Remote hiring grew across Lagos and Nairobi during 2024."];

  it("flags an unmarked sentence stating a percentage", () => {
    const hits = runTripwire("Adoption rose by 42% last year.", known);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reasons[0]).toContain("percentage");
  });

  it("flags an unmarked monetary amount", () => {
    const hits = runTripwire("The market is worth $4bn today.", known);
    expect(hits[0]!.reasons.some((r) => r.includes("monetary"))).toBe(true);
  });

  it("flags a proper noun that appears in no source", () => {
    const hits = runTripwire("According to Fictional Research Group, this is true.", known);
    expect(hits[0]!.reasons.some((r) => r.includes("Fictional Research Group"))).toBe(true);
  });

  it("does not flag a proper noun that does appear in a source", () => {
    const hits = runTripwire("Hiring changed across Lagos and Nairobi.", known);
    expect(hits).toHaveLength(0);
  });

  it("stays quiet on a marked sentence, which the vector check owns instead", () => {
    expect(runTripwire("Adoption rose by 42%. [E1]", known)).toHaveLength(0);
  });

  it("does not flag small ordinals, which are not factual claims", () => {
    // Without this the wire trips on every article that says "three things".
    expect(runTripwire("There are 3 things worth knowing here.", known)).toHaveLength(0);
  });

  it("stays quiet on ordinary narrative connective tissue", () => {
    // §8.3 permits the introduction and CTA to carry no marker, so they must
    // not be flagged — a check that fires on every article gets ignored.
    const hits = runTripwire(
      "This is where most teams get stuck. The good news is that it is fixable.",
      known,
    );
    expect(hits).toHaveLength(0);
  });
});

describe("segmentSentencesWithMarkers", () => {
  it("keeps a trailing marker on the sentence it terminates", () => {
    // §8.3 puts the marker after the full stop, and Intl.Segmenter hands it to
    // the NEXT segment. Without the fix every claim is scored against its
    // neighbour's citation and the whole claim map shifts by one.
    const sentences = segmentSentencesWithMarkers("Adoption rose 42%. [E1] Costs fell. [E2]");
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.text).toContain("[E1]");
    expect(sentences[0]!.text).toContain("42%");
    expect(sentences[1]!.text).toContain("[E2]");
    expect(sentences[1]!.text).toContain("Costs fell");
  });

  it("handles a marker at the very end of the body", () => {
    const sentences = segmentSentencesWithMarkers("Only one claim here. [E1]");
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.text).toContain("[E1]");
  });

  it("keeps a mid-sentence marker where it already is", () => {
    const sentences = segmentSentencesWithMarkers("A claim [E1] continues here. Next one.");
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.text).toContain("[E1]");
  });

  it("indexes contiguously after merging", () => {
    const sentences = segmentSentencesWithMarkers("One. [E1] Two. [E2] Three. [E3]");
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2]);
  });
});

describe("checkInheritedMarkers", () => {
  const articleClaimMap = [
    { sentenceIndex: 0, sentence: "A", labels: ["E1", "E2"], excerptIds: [], sourceIds: [], groundingScore: 0.7, verdict: "grounded" as const },
  ];

  it("passes when the channel output cites only what the article cited", () => {
    expect(checkInheritedMarkers("Short post. [E1]", articleClaimMap).valid).toBe(true);
  });

  it("fails when a channel output introduces a marker the article never had", () => {
    // §12: "The adapter physically cannot introduce a claim that is not in the
    // article." A marker outside the claim map is a hard failure and a retry.
    const result = checkInheritedMarkers("Post. [E7]", articleClaimMap);
    expect(result.valid).toBe(false);
    expect(result.unknownLabels).toEqual(["E7"]);
  });
});

describe("stripMarkers", () => {
  it("removes markers and tidies the spacing a reader would see", () => {
    expect(stripMarkers("Hiring grew fast. [E1] It continued. [E2]")).toBe(
      "Hiring grew fast. It continued.",
    );
  });

  it("does not leave a space before punctuation", () => {
    expect(stripMarkers("A claim [E1].")).toBe("A claim.");
  });
});

describe("resolveLinks", () => {
  const excerpts = [
    excerpt("E1", "text", { sourceUrl: "https://real.example/article" }),
  ];

  it("substitutes the real URL, so the model never writes one", () => {
    // Rule 3: "A link cannot be wrong because the model never writes one."
    const { body, resolved } = resolveLinks(
      "See the original study for detail.",
      [{ anchor: "the original study", label: "E1" }],
      excerpts,
    );
    expect(body).toContain("[the original study](https://real.example/article)");
    expect(resolved[0]!.url).toBe("https://real.example/article");
  });

  it("reports an unresolvable intent rather than inventing a URL", () => {
    const { body, resolved } = resolveLinks(
      "See the missing source.",
      [{ anchor: "the missing source", label: "E99" }],
      excerpts,
    );
    expect(resolved[0]!.url).toBeNull();
    expect(body).not.toContain("](");
  });

  it("does not nest a link inside an existing one", () => {
    const { body } = resolveLinks(
      "See [the original study](https://already.example) here.",
      [{ anchor: "the original study", label: "E1" }],
      excerpts,
    );
    expect(body).toBe("See [the original study](https://already.example) here.");
  });
});

describe("renderExcerptsForPrompt", () => {
  it("renders the labelled format from §8.1", () => {
    const rendered = renderExcerptsForPrompt([
      excerpt("E12", "The finding was clear.", {
        sourceLabel: "S3",
        sourceTitle: "Title of the page",
        siteName: "example.com",
        publishedAt: "2026-03-11T00:00:00Z",
        headingPath: "Heading > Subheading",
      }),
    ]);
    expect(rendered).toContain('[E12] source S3 — "Title of the page" (example.com, 2026-03-11)');
    expect(rendered).toContain("§Heading > Subheading");
  });
});

describe("chunkMarkdown", () => {
  const doc = [
    "# Title",
    "",
    "Intro paragraph with some words in it.",
    "",
    "## Section One",
    "",
    "Body of section one. It has a couple of sentences to pack.",
    "",
    "## Section Two",
    "",
    "Body of section two.",
  ].join("\n");

  it("carries the heading path onto each chunk", () => {
    const chunks = chunkMarkdown(doc);
    expect(chunks.length).toBeGreaterThan(0);
    const paths = chunks.map((c) => c.headingPath);
    expect(paths.some((p) => p.includes("Section One"))).toBe(true);
  });

  it("never packs across a heading boundary", () => {
    const chunks = chunkMarkdown(doc);
    const mixed = chunks.find(
      (c) => c.text.includes("section one") && c.text.includes("section two"),
    );
    expect(mixed).toBeUndefined();
  });

  it("numbers chunks contiguously from zero", () => {
    const chunks = chunkMarkdown(doc);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it("splits a very long block on sentence boundaries, not mid-sentence", () => {
    const long = `## H\n\n${"This is a complete sentence that carries real words. ".repeat(120)}`;
    const chunks = chunkMarkdown(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.trim()).toMatch(/\.$/);
    }
  });

  it("does not lose a single sentence longer than the window", () => {
    const giant = `## H\n\n${"word ".repeat(3000)}`;
    expect(chunkMarkdown(giant).length).toBeGreaterThan(0);
  });
});
