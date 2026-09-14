"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RequestStatus } from "@/lib/db/types";

/**
 * Drives the step runner while a person is watching. DESIGN.md §3.1.
 *
 * "POST /api/runner advances one request by exactly one step and returns. It
 * is driven by the client polling while a user is watching, and by the release
 * cron as a safety net when nobody is."
 *
 * Each call advances at most one step, so the loop continues until the runner
 * says there is no more work or the request reaches a state that waits for a
 * human.
 */

export function RunnerPoll({
  requestId,
  status,
}: {
  requestId: string;
  status: RequestStatus;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string>("Starting…");
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;

    async function step() {
      // One in flight at a time: overlapping calls would both find the lease
      // taken and waste a round trip.
      if (running.current || stopped.current) return;
      running.current = true;

      try {
        const response = await fetch("/api/runner", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `The runner returned ${response.status}.`);
          stopped.current = true;
          router.refresh();
          return;
        }

        const result = (await response.json()) as {
          advanced: boolean;
          message: string;
          more: boolean;
          to: RequestStatus;
        };

        setMessage(result.message);

        // Refresh whenever the state changed, so the page reflects reality
        // rather than the state it was rendered with.
        if (result.advanced) router.refresh();

        if (!result.more) {
          stopped.current = true;
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not reach the runner.");
        stopped.current = true;
      } finally {
        running.current = false;
      }
    }

    void step();
    const timer = setInterval(step, 3_000);

    return () => {
      stopped.current = true;
      clearInterval(timer);
    };
  }, [requestId, router]);

  if (error) {
    return (
      <div className="alert alert-error">
        <strong>The pipeline stopped advancing.</strong> {error}
        <div className="tiny mt-1">
          Nothing was lost — each step stores its output before the next begins, so reloading
          resumes from where it got to.
        </div>
      </div>
    );
  }

  return (
    <div className="alert alert-info">
      <span className="row">
        <span className="spin" />
        <span>
          <strong>{message}</strong>
          <span className="dim"> · {status}</span>
        </span>
      </span>
    </div>
  );
}
