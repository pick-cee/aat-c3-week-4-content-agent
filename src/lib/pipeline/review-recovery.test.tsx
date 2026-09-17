import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextAction } from "@/components/review/next-action";
import { EvaluationReport } from "@/components/evaluation-report";
import { factualRevisionTargets } from "./revision-targets";
import { buildImageQueries } from "./images";
import type { Evaluation } from "@/lib/db/types";

describe("saved review recovery", () => {
  it("does not spend revision slots on weak citations when grounding already passes", () => {
    const review = { computed: { sourceGrounding: { passed: true }, factualConsistency: { passed: true } }, weak_citations: [{ sentence: "Some useful evidence." }] } as unknown as Evaluation;
    expect(factualRevisionTargets("# Title\n\n## Evidence\n\nSome useful evidence.", review)).toEqual([]);
  });
  const evaluation = {
    status: "revise", overall_note: "placeholder", recommended_changes: ["placeholder", "Shorten the introduction."],
    computed: { factualConsistency: { numberDisagreementDetail: [{ sentence: "Workloads increased for 85% of leaders.", number: "85%", labels: ["E2"], citedText: "Eighty-four percent report heavier workloads." }] } },
    sections_to_revise: [{ heading: "Conclusion", problem: "Shorten it." }],
  } as unknown as Evaluation;

  it("locates the failing sentence despite markdown instead of following unrelated style feedback", () => {
    const targets = factualRevisionTargets("# Article\n\nIntroduction\n\n## Screening\n\nWorkloads increased for **85%** of leaders. [E2]\n\n## Conclusion\n\nFinish.", evaluation);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.heading).toBe("Screening");
    expect(targets[0]?.problem).toContain("Eighty-four percent");
  });

  it("does not announce completion when no channel versions exist", () => {
    expect(renderToStaticMarkup(<NextAction outputs={[]} channelsLocked={false} articleLocked={false} status="needs_human" onOpenChannels={() => {}} />)).toBe("");
  });

  it("omits model placeholders from old saved reviews but keeps real recommendations", () => {
    const html = renderToStaticMarkup(<EvaluationReport evaluation={{ ...evaluation, computed: null }} />);
    expect(html).not.toContain("placeholder");
    expect(html).toContain("Shorten the introduction.");
  });

  it("uses concrete short photo queries for an abstract hiring headline", () => {
    expect(buildImageQueries({ title: "Why time-to-hire keeps slipping: screening is where hours disappear", primary_keyword: "time-to-hire" })).toEqual(["job interview", "office meeting"]);
  });
});
