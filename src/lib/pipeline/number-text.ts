// Canonicalise common written figures before comparing an article with its source.
// Keep percentages distinct from counts and compare whole numeric tokens.
const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tens = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const values = new Map([...small.map((word, i) => [word, i] as const), ...tens.map((word, i) => [word, (i + 2) * 10] as const)]);
const separator = "[\\s\\-\\u2010-\\u2013]+";
const units = small.slice(1, 10).join("|");
const under100 = `(?:(?:${tens.join("|")})(?:${separator}(?:${units}))?|${small.join("|")})`;
const written = new RegExp(`\\b(?:(?:${units})${separator}hundred(?:${separator}(?:and${separator})?${under100})?|${under100})\\b`, "gi");

export function normaliseNumberText(text: string): string {
  return text.replace(written, phrase => {
    let total = 0;
    for (const word of phrase.toLowerCase().split(/[\s\-\u2010-\u2013]+/)) {
      if (word === "hundred") total *= 100;
      else total += values.get(word) ?? 0;
    }
    return String(total);
  }).replace(/(\d)\s*(?:percent\b|per\s+cent\b|%)/gi, "$1%");
}

export const NUMBER_TOKEN = /\.\d+%?|\d[\d,]*(?:\.\d+)?%?/g;
