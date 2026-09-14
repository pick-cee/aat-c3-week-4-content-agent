import { describe, it, expect } from "vitest";
import { parseFencedJson, buildSystemForTest } from "./anthropic";

/**
 * The two API limits that produced real 400s in this build, plus the JSON
 * repair path that search depends on.
 */

describe("cache_control breakpoints", () => {
  const cacheable = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ text: `block ${i}`, cache: true }));

  function countBreakpoints(blocks: { text: string; cache?: boolean }[]) {
    return buildSystemForTest(blocks).filter((b) => "cache_control" in b).length;
  }

  it("never exceeds four, which the API refuses with a 400", () => {
    // Drafting sends five: role, SEO rules, citations, linking, brand voice.
    expect(countBreakpoints(cacheable(5))).toBe(4);
    expect(countBreakpoints(cacheable(9))).toBe(4);
  });

  it("leaves a request under the limit untouched", () => {
    expect(countBreakpoints(cacheable(3))).toBe(3);
    expect(countBreakpoints(cacheable(4))).toBe(4);
  });

  it("keeps the LAST breakpoints, which cache the longest prefix", () => {
    const blocks = [
      { text: "first", cache: true },
      { text: "second", cache: true },
      { text: "third", cache: true },
      { text: "fourth", cache: true },
      { text: "fifth", cache: true },
    ];
    const built = buildSystemForTest(blocks);
    // The dropped one is the earliest: a later breakpoint already caches
    // through that point, so nothing is lost.
    expect("cache_control" in built[0]!).toBe(false);
    expect("cache_control" in built[4]!).toBe(true);
  });

  it("ignores uncacheable blocks when counting", () => {
    const blocks = [
      { text: "a" },
      { text: "b", cache: true },
      { text: "c" },
      { text: "d", cache: true },
    ];
    expect(countBreakpoints(blocks)).toBe(2);
  });

  it("preserves every block's text and order", () => {
    const blocks = cacheable(6);
    const built = buildSystemForTest(blocks);
    expect(built).toHaveLength(6);
    expect(built.map((b) => b.text)).toEqual(blocks.map((b) => b.text));
  });
});

describe("parseFencedJson", () => {
  it("reads a fenced block", () => {
    expect(parseFencedJson('Here:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
  });

  it("reads unfenced JSON surrounded by prose", () => {
    expect(parseFencedJson('I found: [{"url":"https://a.co"}] — that is all.')).toEqual([
      { url: "https://a.co" },
    ]);
  });

  it("repairs a trailing comma", () => {
    // §7.1 requires a repair pass before failing: losing a PAID search call to
    // a stray comma is a bad trade.
    expect(parseFencedJson('```json\n{"a":1,}\n```')).toEqual({ a: 1 });
  });

  it("repairs single-quoted keys and values", () => {
    expect(parseFencedJson("```json\n{'a': 'b'}\n```")).toEqual({ a: "b" });
  });

  it("throws with the raw text when nothing parses", () => {
    expect(() => parseFencedJson("no json here at all")).toThrow(/No parseable JSON/);
  });
});
