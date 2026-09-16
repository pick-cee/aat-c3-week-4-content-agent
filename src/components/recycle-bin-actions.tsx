"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreRequest, purgeRequest } from "@/app/actions/requests";

/**
 * Restore, or delete for good.
 *
 * Permanent deletion asks for confirmation in place rather than through a
 * browser dialog, because it is the one action here that cannot be undone —
 * and it still preserves the spend, which the confirmation says out loud so
 * nobody expects deleting to reduce their monthly total.
 */
export function RecycleBinActions({
  requestId,
  canPurge,
}: {
  requestId: string;
  canPurge: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  }

  if (confirming) {
    return (
      <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
        <span className="tiny">Delete for good? Its cost stays in the monthly total.</span>
        <div className="btn-row">
          <button
            className="btn btn-danger btn-sm"
            disabled={pending}
            onClick={() => act(() => purgeRequest(requestId))}
          >
            {pending ? <span className="spin" /> : "Yes, delete for good"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Keep it
          </button>
        </div>
        {error && <span className="tiny danger">{error}</span>}
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
      <div className="btn-row">
        <button
          className="btn btn-sm"
          disabled={pending}
          onClick={() => act(() => restoreRequest(requestId))}
        >
          {pending ? <span className="spin" /> : "Restore"}
        </button>
        {canPurge && (
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
            Delete for good
          </button>
        )}
      </div>
      {error && <span className="tiny danger">{error}</span>}
    </div>
  );
}
