import { articleSections, headingKey } from "./revision-patch";
import { stripMarkdown } from "@/lib/text";
import type { Evaluation } from "@/lib/db/types";

const prose = (text: string) => stripMarkdown(text).replace(/\[E\d+(?:\s*,\s*E\d+)*\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Resolve failing claims to their actual sections before spending tokens on style. */
export function factualRevisionTargets(body: string, evaluation: Evaluation): { heading: string; problem: string }[] {
  const sections = articleSections(body).map(s => ({ ...s, prose: prose(s.body) }));
  const problems = [
    ...(evaluation.computed?.factualConsistency.numberDisagreementDetail ?? []).map(detail => ({
      sentence: detail.sentence,
      problem: `Verify ${detail.number} in "${detail.sentence}" against ${detail.labels.join(", ")}. Correct the figure or citation, or remove the unsupported claim. Source: ${detail.citedText}`,
    })),
    ...[
      ...(evaluation.computed?.sourceGrounding?.passed === false || evaluation.computed?.factualConsistency?.passed === false ? evaluation.unsupported_claims ?? [] : []),
      ...(evaluation.computed?.sourceGrounding?.passed === false ? evaluation.weak_citations ?? [] : []),
    ].map(claim => ({
      sentence: claim.sentence, problem: `Ground this claim in a supplied excerpt or remove it: "${claim.sentence}"`,
    })),
  ];
  const targets = new Map<string, { heading: string; problem: string }>();
  for (const issue of problems) {
    const sentence = prose(issue.sentence);
    const section = sentence && sections.find(s => s.prose.includes(sentence));
    if (!section) continue;
    const key = headingKey(section.heading), existing = targets.get(key);
    targets.set(key, { heading: section.heading, problem: [existing?.problem, issue.problem].filter(Boolean).join("\n") });
  }
  return [...targets.values()];
}
