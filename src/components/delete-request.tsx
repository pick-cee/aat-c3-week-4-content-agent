"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteRequest } from "@/app/actions/requests";
import { Icon } from "./icon";

/**
 * Moves a request to the recycle bin and cancels pending deliveries.
 * The second click confirms the action; already delivered content cannot be recalled.
 */
export function DeleteRequest({ requestId, requestTitle, compact, returnToLibrary = true }: {
  requestId: string; requestTitle?: string; compact?: boolean; returnToLibrary?: boolean;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (error) {
    return (
      <span role="alert" className="tiny" style={{ color: "var(--danger)", maxWidth: 260, textAlign: "right" }}>
        {error}{" "}
        <button
          className="btn-ghost"
          style={{ border: 0, background: "none", padding: 0, cursor: "pointer", color: "inherit", textDecoration: "underline", font: "inherit" }}
          onClick={() => {
            setError(null);
            setArmed(false);
          }}
        >
          dismiss
        </button>
      </span>
    );
  }

  if (!armed) {
    return (
      <button
        className={`btn btn-ghost ${compact ? "btn-sm" : ""}`}
        onClick={() => setArmed(true)}
        title="Move this request to the recycle bin"
        aria-label={requestTitle ? `Delete ${requestTitle}` : "Delete request"}
        type="button"
      >
        <Icon name="trash" size={15} /> Delete
      </button>
    );
  }

  return (
    <span className="delete-request-confirm">
      <span className="tiny muted">Move to recycle bin? Pending deliveries will stop. You can restore it later.</span>
      <span className="btn-row">
      <button
        className="btn btn-danger btn-sm"
        disabled={pending}
        type="button"
        onClick={() =>
          startTransition(async () => {
            try {
              const result = await deleteRequest(requestId);
              if (!result.ok) setError(result.error ?? "Could not delete it.");
              else {
                if (returnToLibrary) router.push("/");
                router.refresh();
              }
            } catch {
              setError("Could not move this request to the recycle bin. Try again.");
            }
          })
        }
      >
        {pending ? "Moving..." : "Yes, delete"}
      </button>
      <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setArmed(false)} type="button">
        Keep
      </button>
      </span>
    </span>
  );
}
