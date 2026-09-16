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

/**
 * Anything that looks like a provider error rather than a progress update.
 *
 * A status code, a JSON body or a stack trace is a diagnostic. It is kept in
 * the activity log, which is where someone debugging goes; it has no business
 * in the banner someone reads to know whether their article is being written.
 */
function presentable(message: string): string | null {
  if (!message) return null;

  const looksLikeAnError =
    /^\d{3}\s/.test(message) ||
    message.includes('{"type"') ||
    message.includes("invalid_request_error") ||
    message.includes("request_id") ||
    /\bError:/.test(message) ||
    message.length > 160;

  return looksLikeAnError ? null : message;
}

/** A plain description of where the pipeline is, when there is nothing better. */
function describeStatus(status: RequestStatus): string {
  switch (status) {
    case "researching": return "Finding and reading sources";
    case "drafting": return "Writing the article";
    case "evaluating": return "Checking the draft against the rubric";
    case "revising": return "Rewriting the sections that need work";
    case "adapting": return "Preparing each channel";
    default: return "Working";
  }
}

export function RunnerPoll({
  requestId,
  status,
}: {
  requestId: string;
  status: RequestStatus;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string>(() => describeStatus(status));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<{ current: number; of: number } | null>(null);
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
          setError(presentable(body.error ?? "") ?? "The pipeline stopped advancing. Nothing was lost, reloading resumes from where it got to.");
          stopped.current = true;
          router.refresh();
          return;
        }

        const result = (await response.json()) as {
          advanced: boolean;
          message: string;
          more: boolean;
          to: RequestStatus;
          attempt?: { current: number; of: number } | null;
        };

        // A retry that is actually happening says so, with a count. A spinner
        // that looks identical to normal progress is how "it retried three
        // times and gave up" becomes "it froze".
        setAttempt(result.attempt ?? null);

        // Never print a raw provider error into the banner. A 400 with a JSON
        // body is a diagnostic, and it belongs in the activity log where an
        // engineer looks — not in the one line a content manager reads to know
        // whether their article is being written.
        setMessage(presentable(result.message) ?? describeStatus(result.to));

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
        {error}
        <div className="tiny mt-1">
          Each step stores its output before the next begins, so nothing produced so far is lost.
          The full detail is in the activity log below.
        </div>
      </div>
    );
  }

  // A retry in progress is its own state, not a variation on "working". The
  // person watching needs to know that something went wrong, that it is being
  // tried again, and how many attempts are left before it stops — otherwise a
  // spinner that never resolves is the only feedback they get.
  if (attempt) {
    return (
      <div className="alert alert-warn">
        <span className="row">
          <span className="spin" />
          <strong>
            {message}, trying again, attempt {attempt.current} of {attempt.of}
          </strong>
        </span>
        <div className="tiny mt-1">
          Everything produced so far is saved. If the last attempt fails, this stops and
          tells you why rather than retrying forever.
        </div>
      </div>
    );
  }

  return (
    <div className="alert alert-info">
      <span className="row">
        <span className="spin" />
        {/* No raw status suffix. "· evaluating" is the database's word for it,
            not something a content manager asked to see. */}
        <strong>{message}…</strong>
      </span>
    </div>
  );
}
