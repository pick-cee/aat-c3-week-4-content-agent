import "server-only";

/**
 * The in-process scheduler.
 *
 * A send time is a promise, and the app has to keep it whether or not anyone
 * is looking. Until now the release worker ran only from `/api/cron/release`,
 * which Vercel Cron drives in production and NOTHING drives on a developer
 * machine — so a newsletter scheduled for 13:30 sat at `queued` past its time,
 * and the only way to move it was a manual request.
 *
 * This runs a timer inside the server process, started once from
 * `instrumentation.ts`. No page needs to be open and no external scheduler
 * needs configuring.
 *
 * It does NOT replace the cron route. On a serverless platform the process is
 * torn down between requests, so the timer stops with it and cron remains the
 * reliable path; the two are safe together because every guarantee lives in
 * `runRelease` itself — the atomic claim means two workers racing is a normal
 * outcome, not a double send (§15.2).
 */

/** Long enough not to be busy work, short enough that a schedule feels kept. */
const INTERVAL_MS = 60_000;

/**
 * A short wait before the first sweep, so startup work (migrations, seed) is
 * finished and the first page load is not competing with a publish.
 */
const FIRST_RUN_DELAY_MS = 10_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler(): void {
  // Next can call register() more than once in development as it recompiles.
  // A second timer would double the sweep rate for no benefit.
  if (timer) return;

  const tick = async () => {
    // One sweep at a time within this process. Overlapping sweeps would both
    // find the rows claimed and waste the work.
    if (running) return;
    running = true;

    try {
      const { runRelease } = await import("./worker");
      const result = await runRelease();

      if (result.claimed > 0) {
        const { logInfo } = await import("@/lib/log");
        await logInfo(
          `Scheduled release: ${result.published} published, ${result.handedOff} handed off, ` +
            `${result.failed} failed, ${result.uncertain} unknown.`,
          {},
        );
      }
    } catch (err) {
      // A failed sweep must not kill the timer, or one bad minute stops every
      // future send. The next tick tries again, and anything genuinely wrong
      // is already recorded on the item itself.
      const { logError } = await import("@/lib/log");
      await logError("A scheduled release sweep failed.", {
        detail: { error: err instanceof Error ? err.message : String(err) },
      }).catch(() => {});
    } finally {
      running = false;
    }
  };

  // A self-rescheduling timeout rather than setInterval: the next sweep is
  // booked only after the previous one finishes, so a slow send can never
  // stack invocations on top of each other.
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      void tick().finally(() => schedule(INTERVAL_MS));
    }, delay);
    // Never hold the process open on its own account: a timer that keeps Node
    // alive turns a clean shutdown into a hang.
    timer.unref?.();
  };

  schedule(FIRST_RUN_DELAY_MS);
}
