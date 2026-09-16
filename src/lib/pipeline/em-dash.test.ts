import { describe, it, expect } from "vitest";
import { countEmDashes, replaceEmDashes } from "./checks";

/**
 * Em dashes are the clearest tell that a machine wrote the text, and asking a
 * model not to use them does not work reliably. So they are measured and
 * repaired in code (rule 2: verify the instruction, do not trust it).
 *
 * The risk in a blunt find-and-replace is mangling legitimate text, so these
 * pin down what must NOT change as firmly as what must.
 */

describe("countEmDashes", () => {
  it("counts spaced em dashes", () => {
    expect(countEmDashes("Hiring is hard — especially remotely.")).toBe(1);
  });

  it("counts unspaced em dashes", () => {
    expect(countEmDashes("Hiring is hard—especially remotely.")).toBe(1);
  });

  it("does not count a numeric en dash range", () => {
    // "2020–2024" and "10–15%" are correct typography, not AI tells.
    expect(countEmDashes("Between 2020–2024 the figure rose.")).toBe(0);
    expect(countEmDashes("Expect 10–15% churn.")).toBe(0);
  });

  it("does not count hyphens", () => {
    expect(countEmDashes("A well-known, cutting-edge approach.")).toBe(0);
  });

  it("finds every dash in a paragraph", () => {
    expect(
      countEmDashes("One — two — three."),
    ).toBe(2);
  });
});

describe("replaceEmDashes", () => {
  it("turns a spaced em dash into a comma", () => {
    expect(replaceEmDashes("Hiring is hard — especially remotely.")).toBe(
      "Hiring is hard, especially remotely.",
    );
  });

  it("turns an unspaced em dash into a comma and a space", () => {
    expect(replaceEmDashes("Hiring is hard—especially remotely.")).toBe(
      "Hiring is hard, especially remotely.",
    );
  });

  it("handles a parenthetical pair", () => {
    expect(
      replaceEmDashes("The process — all four rounds of it — takes a month."),
    ).toBe("The process, all four rounds of it, takes a month.");
  });

  it("leaves a numeric range alone", () => {
    expect(replaceEmDashes("Between 2020–2024 it rose.")).toBe("Between 2020–2024 it rose.");
  });

  it("leaves hyphenated words alone", () => {
    const text = "A well-known, cutting-edge, full-time approach.";
    expect(replaceEmDashes(text)).toBe(text);
  });

  it("does not leave doubled punctuation behind", () => {
    // "word — ." would otherwise become "word, ." which reads as a typo.
    expect(replaceEmDashes("It was late — .")).toBe("It was late.");
    expect(replaceEmDashes("It was late —, really.")).toBe("It was late, really.");
  });

  it("removes every dash in a longer passage", () => {
    const out = replaceEmDashes(
      "Remote hiring fails — usually — for one reason: the process is vague.",
    );
    expect(countEmDashes(out)).toBe(0);
    expect(out).toBe("Remote hiring fails, usually, for one reason: the process is vague.");
  });

  it("leaves clean text untouched", () => {
    const text = "Remote hiring fails for one reason: the process is vague.";
    expect(replaceEmDashes(text)).toBe(text);
  });
});
