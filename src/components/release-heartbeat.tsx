"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { releaseDueItems } from "@/app/actions/release";

/**
 * Sends what is due, from whatever page is open.
 *
 * This used to live only on the queue page, so a send time was kept only if
 * someone happened to be looking at the queue. It sits in the app layout now:
 * any signed-in page keeps the schedule.
 *
 * It is NOT the scheduler, and must not be mistaken for one. Nobody has a tab
 * open at 03:00, and a serverless platform has no process to keep time in
 * between requests. `.github/workflows/release.yml` is the guarantee; this
 * makes the common case (someone is using the app) feel immediate rather than
 * waiting for the next external run.
 *
 * Every guarantee lives in `runRelease`: the claim is one atomic statement, so
 * this racing the external scheduler is a normal outcome, not a double send
 * (§15.2).
 */

/** A send time is chosen to the minute, so checking twice a minute is enough. */
const POLL_MS = 30_000;

export function ReleaseHeartbeat() {
  const router = useRouter();
  const running = useRef(false);

  useEffect(() => {
    let stopped = false;

    async function tick() {
      // A background tab should not keep publishing: the external scheduler
      // covers that, and waking on focus is enough.
      if (running.current || stopped || document.hidden) return;
      running.current = true;

      try {
        const result = await releaseDueItems();
        // Only refresh when something actually moved, so an idle tab is not
        // re-rendering every thirty seconds for nothing.
        if (!stopped && result.ok && (result.data?.claimed ?? 0) > 0) {
          router.refresh();
        }
      } catch {
        // A failed sweep is not worth a banner. The next tick tries again, and
        // anything genuinely wrong is recorded on the item itself.
      } finally {
        running.current = false;
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_MS);
    // Coming back to the tab is the moment a stale queue is most visible.
    document.addEventListener("visibilitychange", tick);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);

  return null;
}
