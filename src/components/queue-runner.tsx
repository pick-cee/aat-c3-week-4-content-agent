"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { releaseDueItems } from "@/app/actions/release";

/**
 * Sends what is due, while the queue is open.
 *
 * A newsletter scheduled for 13:30 stayed `queued` past its time because the
 * release worker only ran from cron, which does not exist on a developer
 * machine. The same pattern the pipeline uses solves it: the client drives the
 * work while someone is watching, and cron remains the safety net for when
 * nobody is.
 *
 * It runs on mount and then every 30 seconds — a send time is a minute-level
 * promise, not a second-level one, and a queue nobody is looking at is handled
 * by the cron path anyway.
 */
const POLL_MS = 30_000;

export function QueueRunner() {
  const router = useRouter();
  const running = useRef(false);
  const [sent, setSent] = useState<number | null>(null);

  useEffect(() => {
    let stopped = false;

    async function tick() {
      // One in flight at a time: overlapping calls would both find the rows
      // claimed and waste a round trip.
      if (running.current || stopped) return;
      running.current = true;

      try {
        const result = await releaseDueItems();
        if (!stopped && result.ok && (result.data?.claimed ?? 0) > 0) {
          setSent((result.data?.published ?? 0) + (result.data?.handedOff ?? 0));
          router.refresh();
        }
      } catch {
        // A failed sweep is not worth a banner: the next tick tries again, and
        // anything genuinely wrong is already a row on the item itself.
      } finally {
        running.current = false;
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [router]);

  if (!sent) return null;

  return (
    <div className="alert alert-ok small">
      {sent} item{sent === 1 ? "" : "s"} went out just now.
    </div>
  );
}
