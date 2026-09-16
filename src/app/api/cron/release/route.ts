import { NextResponse } from "next/server";
import { runRelease } from "@/lib/publish/worker";
import { verifyCronSecret } from "@/lib/crypto";
import { serviceClient } from "@/lib/db/client";
import { logError } from "@/lib/log";

/**
 * The release worker. DESIGN.md §15.2.
 *
 * Authenticated by a shared secret compared with timingSafeEqual — "an
 * unauthenticated publish endpoint is a stranger's message to your audience"
 * (§19.5).
 *
 * Also acts as the runner's safety net: after draining the queue it advances
 * one in-flight request, so a pipeline nobody is watching still progresses
 * (§3.1).
 *
 * WHO CALLS THIS, and why `vercel.json` has no `crons` block:
 *
 * Vercel's Hobby plan allows one cron run a day and rejects a sub-daily
 * schedule outright, which cannot keep a send time a person chose to the
 * minute. `.github/workflows/release.yml` calls this every minute instead,
 * with the same shared secret.
 *
 * Two things that are NOT schedulers here. `lib/publish/scheduler.ts` keeps
 * time inside a long-running server process, which serverless does not have:
 * the instance is frozen after the response, so its timer fires only when
 * something else has kept it warm. And `components/release-heartbeat.tsx`
 * sends what is due from whatever page is open, which helps nobody at 03:00.
 * Both are conveniences; the workflow is the guarantee.
 *
 * On a Pro plan, add the `crons` block back and delete the workflow. Running
 * both is harmless: the claim is one atomic statement, so two schedulers
 * racing is a normal outcome rather than a double send (§15.2).
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  // Vercel Cron sends the secret as a bearer token; an external scheduler can
  // send the same header.
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    // Deliberately terse: an attacker learns nothing from this response.
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  try {
    const result = await runRelease();
    const advanced = await advanceOnePipeline();

    return NextResponse.json({ ...result, pipelineAdvanced: advanced });
  } catch (err) {
    await logError("The release worker itself failed.", {
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * Advances one request that is mid-pipeline. Best-effort: a failure here must
 * not fail the release run, which is the more time-critical job.
 */
async function advanceOnePipeline(): Promise<boolean> {
  try {
    const { data } = await serviceClient().rpc("claim_next_runnable_request", {
      p_lease_id: `cron-${Date.now()}`,
      p_lease_secs: 5,
    });

    // `setof` returns an array; empty means nothing was runnable. The id
    // check also guards the old scalar shape, where "nothing" arrived as an
    // object of nulls and passed a plain truthiness test.
    const row = (Array.isArray(data) ? data[0] : data) as { id?: string } | undefined;
    if (!row?.id) return false;

    const { runStep } = await import("@/lib/pipeline/runner");
    await runStep(row.id);
    return true;
  } catch {
    return false;
  }
}
