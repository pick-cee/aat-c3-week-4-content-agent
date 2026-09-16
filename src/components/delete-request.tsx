"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteRequest } from "@/app/actions/requests";

/**
 * Deletes a request and everything under it.
 *
 * Two clicks, not a confirm() dialog: the second click is the confirmation,
 * and it says what is about to happen. The action refuses anything that has
 * already published, so the dangerous case is handled server-side rather than
 * by hoping the button is not clicked.
 */
export function DeleteRequest({ requestId, compact }: { requestId: string; compact?: boolean }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (error) {
    return (
      <span className="tiny" style={{ color: "var(--danger)", maxWidth: 260, textAlign: "right" }}>
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
        title="Delete this request and everything under it"
        type="button"
      >
        Delete
      </button>
    );
  }

  return (
    <span className="btn-row">
      <span className="tiny muted nowrap">Delete for good?</span>
      <button
        className="btn btn-danger btn-sm"
        disabled={pending}
        type="button"
        onClick={() =>
          startTransition(async () => {
            const result = await deleteRequest(requestId);
            if (!result.ok) setError(result.error ?? "Could not delete it.");
            else {
              // May be on the request's own page, which no longer exists.
              router.push("/");
              router.refresh();
            }
          })
        }
      >
        {pending ? <span className="spin" /> : "Yes, delete"}
      </button>
      <button className="btn btn-ghost btn-sm" onClick={() => setArmed(false)} type="button">
        Keep
      </button>
    </span>
  );
}
