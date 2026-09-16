import { NextResponse } from "next/server";
import { runStep } from "@/lib/pipeline/runner";
import { currentProfile, serviceClient } from "@/lib/db/client";
import { verifyCronSecret } from "@/lib/crypto";

/**
 * POST /api/runner — advances ONE request by exactly ONE step, then returns.
 *
 * DESIGN.md §3.1 and rule 7b: "No pipeline step runs inside the user's
 * request. A long-running route that dies at the platform timeout leaves no
 * record of where it got to, which is the failure this whole build exists to
 * avoid."
 *
 * Driven by the client polling while a user is watching, and by the release
 * cron as a safety net when nobody is.
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Two callers: a signed-in person watching the request, or the cron safety
  // net. Anything else is refused — this route spends money.
  const isCron = verifyCronSecret(request.headers.get("authorization"));
  const profile = isCron ? null : await currentProfile();

  if (!isCron && !profile) {
    return NextResponse.json(
      { error: "You need to be signed in to advance a request." },
      { status: 401 },
    );
  }

  let requestId: string | undefined;
  try {
    const body = (await request.json()) as { requestId?: string };
    requestId = body.requestId;
  } catch {
    // No body is valid for the cron caller: it picks up whatever is due.
  }

  if (!requestId) {
    if (!isCron) {
      return NextResponse.json({ error: "requestId is required." }, { status: 400 });
    }

    // Claim the oldest runnable request in one statement (§3.1).
    const { data } = await serviceClient().rpc("claim_next_runnable_request", {
      p_lease_id: `cron-${Date.now()}`,
      p_lease_secs: 5,
    });

    // `setof` returns an array; empty means nothing was runnable.
    const row = (Array.isArray(data) ? data[0] : data) as { id?: string } | undefined;
    if (!row?.id) {
      return NextResponse.json({ advanced: false, message: "Nothing to advance." });
    }
    requestId = row.id;
  }

  try {
    const result = await runStep(requestId);
    return NextResponse.json(result);
  } catch (err) {
    // runStep handles its own step failures; reaching here means the runner
    // itself broke, which is worth a 500 rather than a cheerful 200.
    return NextResponse.json(
      {
        advanced: false,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
