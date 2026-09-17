"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  resolveUncertain,
  rescheduleItem,
  cancelQueueItem,
} from "@/app/actions/approvals";
import type { PublishQueueItem } from "@/lib/db/types";

/**
 * Per-item queue actions. DESIGN.md §15.5, §16.
 *
 * The `uncertain` case is the important one: "Not found means it is offered to
 * a human with **It sent / It did not** and the actual content, and only a
 * person moves it." There is deliberately no retry button — retrying an
 * unknown write is how one recipient gets the same message twice.
 */

export function QueueActions({
  item,
  canApprove,
}: {
  item: PublishQueueItem;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [when, setWhen] = useState("");
  const [showReschedule, setShowReschedule] = useState(false);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await fn();
        if (!result.ok) setError(result.error ?? "That did not work.");
        else router.refresh();
      } catch { setError("Connection interrupted. Refresh to check the saved state before trying again."); }
    });
  }

  if (!canApprove) return null;

  // ── uncertain: the only way out is a person saying which it was ──
  if (item.status === "uncertain") {
    return (
      <div className="stack" style={{ flex: "none", maxWidth: 280, gap: 6 }}>
        {error && <div className="alert alert-error tiny mb-0">{error}</div>}

        <div className="tiny strong" style={{ color: "var(--danger)" }}>
          Did this go out?
        </div>

        {item.kind === "handoff" && (
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="URL of the post, if it went"
            style={{ fontSize: 13 }}
          />
        )}

        <div className="btn-row">
          <button
            className="btn btn-sm"
            disabled={pending || (item.kind === "handoff" && !url.trim())}
            onClick={() => act(() => resolveUncertain(item.id, true, url || undefined))}
          >
            It sent
          </button>
          <button
            className="btn btn-sm"
            disabled={pending}
            onClick={() => act(() => resolveUncertain(item.id, false))}
          >
            It did not
          </button>
        </div>

        <div className="tiny dim">
          It will not be retried until you say. Retrying an unknown send is how someone receives
          the same message twice.
        </div>
      </div>
    );
  }

  // ── awaiting a manual post: nothing to do here, the poster holds the link ──
  if (item.status === "awaiting_manual_post") {
    return (
      <div className="stack" style={{ flex: "none", maxWidth: 240, gap: 6 }}>
        <div className="tiny muted">
          Waiting for whoever posts it to confirm with a URL. This is not published.
        </div>
        <button
          className="btn btn-sm btn-ghost"
          disabled={pending}
          onClick={() => act(() => cancelQueueItem(item.id))}
        >
          Cancel
        </button>
      </div>
    );
  }

  const isHeld = item.status === "held";
  const canReschedule = ["queued", "held", "blocked_not_connected", "failed"].includes(item.status);

  if (!canReschedule) return null;

  return (
    <div className="stack" style={{ flex: "none", gap: 6 }}>
      {error && <div className="alert alert-error tiny mb-0">{error}</div>}

      {showReschedule ? (
        <div className="btn-row">
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            style={{ width: "auto", fontSize: 13 }}
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={pending || !when}
            onClick={() =>
              act(async () => {
                const result = await rescheduleItem(item.id, new Date(when).toISOString());
                if (result.ok) setShowReschedule(false);
                return result;
              })
            }
          >
            Set
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setShowReschedule(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="btn-row">
          {/* A held item has never had a time, so "Reschedule" would be the
              wrong word for the one action it needs. */}
          <button
            className={isHeld ? "btn btn-sm btn-primary" : "btn btn-sm"}
            onClick={() => setShowReschedule(true)}
          >
            {isHeld ? "Set a send time" : "Reschedule"}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            disabled={pending}
            onClick={() => act(() => cancelQueueItem(item.id))}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
