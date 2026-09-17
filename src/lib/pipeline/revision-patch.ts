import { PermanentPipelineError } from "./errors";

export const OPENING_SECTION = "Article opening";
export const headingKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function articleSections(markdown: string): { heading: string; body: string }[] {
  const parts: { heading: string; body: string }[] = [];
  let heading = OPENING_SECTION, lines: string[] = [], fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) fence = fence?.[0] === delimiter[0] ? null : fence ?? delimiter;
    const match = !fence && !delimiter ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (match) { parts.push({ heading, body: lines.join("\n") }); heading = match[1]!; lines = []; }
    lines.push(line);
  }
  parts.push({ heading, body: lines.join("\n") });
  return parts;
}

export interface RevisionPatch { sections: { heading: string; markdown: string }[] }
export const REVISION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["sections"],
  properties: { sections: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["heading", "markdown"],
    properties: { heading: { type: "string" }, markdown: { type: "string" } },
  } } },
} as const;

/** Apply bounded edits, including the introduction and missing outline sections. */
export function applyRevisionPatch(original: string, patch: RevisionPatch, allowed: string[], maxSections: number): string {
  if (!Array.isArray(patch?.sections) || !patch.sections.length || patch.sections.length > maxSections) {
    throw new PermanentPipelineError("The revision did not return a bounded set of section edits.");
  }
  const allowedKeys = new Set(allowed.map(headingKey)), seen = new Set<string>();
  const replacements = new Map<string, string>();
  for (const section of patch.sections) {
    const key = headingKey(section.heading);
    if (!allowedKeys.has(key) || seen.has(key) || !section.markdown.trim()) {
      throw new PermanentPipelineError("The revision returned an empty, repeated or unrequested section.");
    }
    seen.add(key);
    const parts = articleSections(section.markdown);
    if (key === headingKey(OPENING_SECTION)) {
      if (parts.length !== 1 || (section.markdown.match(/^#\s+.+$/gm) ?? []).length !== 1) {
        throw new PermanentPipelineError("The revised opening must contain one title and no H2 sections.");
      }
    } else if (parts.length !== 2 || parts[0]!.body.trim() || headingKey(parts[1]!.heading) !== key || /^#\s+/m.test(section.markdown)) {
      throw new PermanentPipelineError("Each revision must contain only its named H2 section.");
    }
    replacements.set(key, section.markdown.trim());
  }
  const output = articleSections(original).map(section => {
    const key = headingKey(section.heading), replacement = replacements.get(key);
    replacements.delete(key);
    return replacement ?? section.body.trim();
  });
  // Allowed new headings come only from the human-approved outline.
  output.push(...replacements.values());
  const revised = output.join("\n\n").trim();
  if (revised === original.trim()) throw new PermanentPipelineError("The revision returned the same article without a change.");
  return revised;
}
