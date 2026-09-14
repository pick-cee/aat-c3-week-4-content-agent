import type { ContentRequest, RequestStatus } from "@/lib/db/types";

/**
 * The pipeline as a horizontal stepper with the current step lit (§16).
 *
 * A request that dies halfway is never ambiguous about where it died (§3), so
 * a failure marks the step that owns it rather than the whole bar.
 */

const STAGES = [
  { key: "research", label: "Research", statuses: ["researching"] },
  { key: "plan_review", label: "Your review", statuses: ["plan_review"] },
  { key: "draft", label: "Draft", statuses: ["drafting"] },
  { key: "evaluate", label: "Evaluate", statuses: ["evaluating", "revising"] },
  { key: "adapt", label: "Channels", statuses: ["adapting"] },
  { key: "content_review", label: "Your approval", statuses: ["content_review"] },
  { key: "publish", label: "Publish", statuses: ["scheduled", "publishing", "published"] },
] as const;

/** Which stage a step belongs to, for marking the failure. */
const STEP_STAGE: Record<string, string> = {
  discover: "research",
  fetch: "research",
  chunk_embed: "research",
  score: "research",
  plan: "research",
  draft: "draft",
  evaluate: "evaluate",
  revise: "evaluate",
  adapt: "adapt",
  image: "adapt",
};

export function Stepper({ request }: { request: ContentRequest }) {
  const currentIndex = STAGES.findIndex((stage) =>
    (stage.statuses as readonly string[]).includes(request.status),
  );

  const failed = ["failed", "budget_exceeded", "needs_human"].includes(request.status);
  const failedStage = failed
    ? STEP_STAGE[request.failed_step ?? request.current_step ?? ""] ?? null
    : null;

  // A terminal failure has no "current" stage, so position is taken from where
  // it stopped rather than from the status.
  const effectiveIndex =
    currentIndex >= 0
      ? currentIndex
      : failedStage
        ? STAGES.findIndex((s) => s.key === failedStage)
        : request.status === "published"
          ? STAGES.length - 1
          : -1;

  return (
    <div className="stepper">
      {STAGES.map((stage, index) => {
        const isFailed = failedStage === stage.key;
        const isCurrent = !isFailed && index === effectiveIndex;
        const isDone = !isFailed && index < effectiveIndex;

        const className = isFailed
          ? "step step-failed"
          : isCurrent
            ? "step step-current"
            : isDone
              ? "step step-done"
              : "step";

        return (
          <div key={stage.key} style={{ display: "contents" }}>
            {index > 0 && <div className="step-sep" />}
            <div className={className} title={titleFor(stage.key, request)}>
              <span className="step-mark">
                {isFailed ? "!" : isDone ? "✓" : index + 1}
              </span>
              {stage.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function titleFor(stageKey: string, request: ContentRequest): string {
  if (
    ["failed", "budget_exceeded", "needs_human"].includes(request.status) &&
    STEP_STAGE[request.failed_step ?? ""] === stageKey
  ) {
    return request.failure_reason ?? "Stopped here.";
  }

  switch (stageKey) {
    case "research":
      return "Find sources, read them, index and rank them.";
    case "plan_review":
      return "You confirm the sources and choose an angle.";
    case "draft":
      return "The article is written from the stored excerpts.";
    case "evaluate":
      return "Computed checks and a judged rubric. Weak sections are rewritten.";
    case "adapt":
      return "Each channel version is produced and format-checked.";
    case "content_review":
      return "You approve each channel independently.";
    case "publish":
      return "Approved content is released on schedule.";
    default:
      return "";
  }
}

/** A short line naming what is happening now, for the polling banner. */
export function currentStepLabel(status: RequestStatus, step: string | null): string {
  switch (step) {
    case "discover": return "Searching for material";
    case "fetch": return "Reading the pages";
    case "chunk_embed": return "Indexing what was read";
    case "score": return "Ranking the sources";
    case "plan": return "Working out three angles";
    case "draft": return "Writing the article";
    case "evaluate": return "Grading the draft";
    case "revise": return "Rewriting the weak sections";
    case "adapt": return "Producing the channel versions";
    case "image": return "Finding an image";
    default:
      return status === "researching" ? "Researching" : "Working";
  }
}
