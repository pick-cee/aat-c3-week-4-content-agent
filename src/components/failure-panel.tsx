"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryRequest, raiseBudget, cancelRequest } from "@/app/actions/requests";
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
  const [newBudget, setNewBudget] = useState(String(request.budget_cents * 2));

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

        <p className="mb-2">{request.failure_reason ?? "No reason was recorded."}</p>

        {overBudget && (
          <div className="alert alert-warn small">
            Spent <Cost cents={request.actual_cost_cents} complete={request.cost_complete} /> of a{" "}
            <Cost cents={request.budget_cents} /> budget. Everything produced so far is intact and
            nothing was published.
          </div>
        )}

        {request.status === "needs_human" && (
          <div className="alert alert-warn small">
            This did not fail — it reached a point where a person has to decide. Nothing was
            published.
          </div>
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
            <span className="row" style={{ gap: 6 }}>
              <input
                type="number"
                value={newBudget}
                onChange={(e) => setNewBudget(e.target.value)}
                style={{ width: 110 }}
                aria-label="New budget in cents"
              />
              <button
                className="btn btn-sm"
                disabled={pending}
                onClick={() =>
                  act(async () => {
                    const raised = await raiseBudget(
                      request.id,
                      Number.parseInt(newBudget, 10) || 0,
                    );
                    if (!raised.ok) return raised;
                    return retryRequest(request.id);
                  })
                }
              >
                Raise budget and continue
              </button>
            </span>
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
