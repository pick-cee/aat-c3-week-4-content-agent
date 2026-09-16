"use server";

import { revalidatePath } from "next/cache";
import { currentProfile } from "@/lib/db/client";
import { runRelease } from "@/lib/publish/worker";
import type { ActionResult } from "./requests";

/**
 * Drains due queue items while someone is watching the queue.
 *
 * The release worker was reachable only through `/api/cron/release`, which is
 * driven by Vercel Cron in production and by nothing at all locally — so a
 * newsletter scheduled for 13:30 sat at `queued` past its time with no way to
 * move it except a manual curl.
 *
 * This is the same arrangement the pipeline already uses (§3.1): the client
 * drives the work while a person is present, and cron is the safety net for
 * when nobody is. It changes WHO calls the worker, not what the worker does —
 * every guarantee still lives inside `runRelease`: the atomic claim, the
 * approval re-check, `uncertain` on an unknown outcome.
 *
 * Signed in only. The cron route keeps its shared-secret check for the
 * unattended path; an unauthenticated publish endpoint is a stranger's message
 * to your audience (§19.5).
 */
export async function releaseDueItems(): Promise<
  ActionResult<{ claimed: number; published: number; handedOff: number }>
> {
  const profile = await currentProfile();
  if (!profile) return { ok: false, error: "You need to be signed in." };

  try {
    const result = await runRelease();

    if (result.claimed > 0) {
      revalidatePath("/queue");
      revalidatePath("/");
    }

    return {
      ok: true,
      data: {
        claimed: result.claimed,
        published: result.published,
        handedOff: result.handedOff,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The release worker failed.",
    };
  }
}
