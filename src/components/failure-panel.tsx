"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryRequest, raiseBudget, cancelRequest } from "@/app/actions/requests";
import { requestRevision, acceptDespiteChecks } from "@/app/actions/approvals";
import { Cost } from "./status";
import type { ContentRequest } from "@/lib/db/types";

/**
 * What went wrong, and what can be done about it. DESIGN.md §17.
 *
 * "Retry is offered only where retrying could help. A 404 source, a rejected
 * draft that failed marker integrity twice, a 400 from a platform — no retry
 * button."
 */

export function FailurePanel({
  request,
  canApprove,
}: {
  request: ContentRequest;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Dollars, prefilled at double the current budget as a sensible default.
  const [deciding, setDeciding] = useState<"revise" | "accept" | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [newBudget, setNewBudget] = useState(((request.budget_cents * 2) / 100).toFixed(2));

  const overBudget = request.status === "budget_exceeded";
  const retryable = isRetryable(request);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  }

  return (
    <div className="card mb-3" style={{ borderColor: "#fecaca" }}>
      <div className="card-head" style={{ background: "var(--danger-soft)" }}>
        <h2 style={{ fontSize: 15, color: "var(--danger)" }}>{headline(request)}</h2>
        {request.failed_step && (
          <span className="tiny" style={{ color: "var(--danger)" }}>
            Stopped at: {request.failed_step}
          </span>
        )}
      </div>

      <div className="card-pad">
        {error && <div className="alert alert-error">{error}</div>}

        {/* The technical detail is one disclosure below, and the full error is
            in the activity log. What shows here is what a content manager can
            act on. */}
        <p className="mb-2">{readableReason(request)}</p>

        {overBudget && (
          <div className="alert alert-warn small">
            Spent <Cost cents={request.actual_cost_cents} complete={request.cost_complete} /> of a{" "}
            <Cost cents={request.budget_cents} /> budget. Everything produced so far is intact and
            nothing was published.
          </div>
        )}

        {request.status === "needs_human" && (
          <>
            <div className="alert alert-warn small">
              This did not fail, it reached a point where a person has to decide. Nothing was
              published, and the draft is below.
            </div>

            {/* The choices, spelled out.
                The panel named the problem and offered "Cancel this request",
                which is not a decision, it is an exit. A reviewer arriving
                here has a finished article in front of them and three real
                options. */}
            {/* The pipeline stops BEFORE adaptation when it reaches
                needs_human, so there are no channel versions yet. Telling a
                reviewer to "approve the channels you want" when the Channels
                tab reads "No channel versions were produced" is the system
                contradicting itself. */}
            <div className="small">
              <strong>What you can do</strong>
              <ol className="change-list mt-1">
                <li>
                  <strong>Send it back with a note</strong> saying what to change. This is the
                  usual answer: the note goes straight into the rewrite, which is better
                  information than the automatic rounds had.
                </li>
                <li>
                  <strong>Edit the draft yourself</strong> in the Draft tab and save it. Saving
                  re-runs every check, so you see at once whether your edit cleared them.
                </li>
                <li>
                  <strong>Accept it as it stands.</strong> The channel versions have not been
                  written yet; accepting produces them and takes you to the normal approval
                  screen.
                </li>
              </ol>
            </div>
          </>
        )}

        {request.failure_detail && (
          <details className="mt-2">
            <summary className="small muted" style={{ cursor: "pointer" }}>
              Technical detail
            </summary>
            <pre className="preview tiny mono mt-1" style={{ overflow: "auto" }}>
              {JSON.stringify(request.failure_detail, null, 2)}
            </pre>
          </details>
        )}

        {deciding && (
          <div className="field mt-2">
            <label htmlFor="decision-note">
              {deciding === "revise"
                ? "What should change?"
                : "Why are you accepting it despite the failing checks?"}
            </label>
            <textarea
              id="decision-note"
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              rows={3}
              placeholder={
                deciding === "revise"
                  ? "Be specific. This goes straight into the rewrite."
                  : "Recorded against the approval, so the override is attributable."
              }
            />
            <div className="btn-row mt-1">
              <button
                className="btn btn-sm btn-primary"
                disabled={pending || !decisionNote.trim()}
                onClick={() =>
                  act(async () => {
                    const result =
                      deciding === "revise"
                        ? await requestRevision(request.id, decisionNote)
                        : await acceptDespiteChecks(request.id, decisionNote);
                    if (result.ok) {
                      setDeciding(null);
                      setDecisionNote("");
                    }
                    return result;
                  })
                }
              >
                {pending ? (
                  <span className="spin" />
                ) : deciding === "revise" ? (
                  "Send for revision"
                ) : (
                  "Accept and prepare the channels"
                )}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setDeciding(null);
                  setDecisionNote("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="row mt-2">
          {retryable && (
            <button
              className="btn btn-primary btn-sm"
              disabled={pending}
              onClick={() => act(() => retryRequest(request.id))}
            >
              {pending ? <span className="spin" /> : "Retry from this step"}
            </button>
          )}

          {overBudget && canApprove && (
            // Dollars, not cents. The field held a raw cent value with the
            // unit only in an aria-label, so "120" on screen meant $1.20 and
            // nothing said so — a person topping up a budget would reasonably
            // read that as one hundred and twenty dollars.
            <span className="btn-row">
              <label className="small" htmlFor="new-budget">
                New budget $
              </label>
              <input
                id="new-budget"
                type="number"
                min="0"
                step="0.01"
                value={newBudget}
                onChange={(e) => setNewBudget(e.target.value)}
                style={{ width: 90 }}
              />
              <button
                className="btn btn-sm"
                disabled={pending}
                onClick={() =>
                  act(async () => {
                    const dollars = Number.parseFloat(newBudget);
                    if (!Number.isFinite(dollars) || dollars <= 0) {
                      return { ok: false as const, error: "Enter a budget greater than zero." };
                    }
                    const raised = await raiseBudget(request.id, Math.round(dollars * 100));
                    if (!raised.ok) return raised;
                    return retryRequest(request.id);
                  })
                }
              >
                Raise budget and continue
              </button>
            </span>
          )}

          {/* The two decisions a needs_human reviewer actually has. Both take
              a note, because both override a measured check. */}
          {request.status === "needs_human" && canApprove && (
            <>
              <button
                className="btn btn-sm btn-primary"
                disabled={pending}
                onClick={() => setDeciding(deciding === "revise" ? null : "revise")}
              >
                Send back with a note
              </button>
              <button
                className="btn btn-sm"
                disabled={pending}
                onClick={() => setDeciding(deciding === "accept" ? null : "accept")}
              >
                Accept it anyway
              </button>
            </>
          )}

          <button
            className="btn btn-sm btn-ghost"
            disabled={pending}
            onClick={() => act(() => cancelRequest(request.id))}
          >
            Cancel this request
          </button>
        </div>

        {!retryable && request.status === "failed" && (
          <p className="tiny dim mt-2 mb-0">
            No retry is offered because retrying this would produce the same result.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * What the failure means, in the reader's terms.
 *
 * `failure_reason` is written for whoever debugs it and sometimes carries a
 * provider's own words — a content manager once saw "the model hit its
 * 4,000-token limit", which names an implementation detail they never chose
 * and cannot act on. The raw text stays in the activity log and the technical
 * detail below; this is the sentence at the top of the panel.
 */
function readableReason(request: ContentRequest): string {
  const raw = request.failure_reason ?? "";

  if (!raw) return "No reason was recorded, which is itself worth reporting.";

  if (/token limit|ran out of room|max_tokens/i.test(raw)) {
    return (
      "The writing step ran out of room and stopped part-way. This is usually " +
      "transient, retrying gives it more space to finish."
    );
  }

  if (/rate limit|429|overloaded/i.test(raw)) {
    return "The AI provider was busy and turned the request away. Retrying shortly usually works.";
  }

  if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(raw)) {
    return "A request took too long and was abandoned. Retrying usually works.";
  }

  // A raw provider payload: a status line, a JSON body, a request id.
  if (/^\d{3}\s/.test(raw) || raw.includes('{"type"') || raw.includes("request_id")) {
    return (
      "The AI provider refused the request. The exact response is in the " +
      "technical detail below and in the activity log."
    );
  }

  return raw;
}

function headline(request: ContentRequest): string {
  switch (request.status) {
    case "budget_exceeded":
      return "Stopped: the budget was reached";
    case "needs_human":
      return "This needs a person";
    default:
      return "This request failed";
  }
}

/**
 * Retry is offered only where it could actually help (§17). A marker-integrity
 * failure that already retried, or a topic that returned nothing, will do the
 * same thing again.
 */
function isRetryable(request: ContentRequest): boolean {
  if (request.status === "budget_exceeded") return false;

  if (request.research_outcome === "no_sources_found") return false;
  if (request.research_outcome === "insufficient_sources") return false;

  const reason = (request.failure_reason ?? "").toLowerCase();
  if (reason.includes("twice cited excerpts that do not exist")) return false;
  if (reason.includes("still failed evaluation")) return false;

  return request.status === "failed";
}
