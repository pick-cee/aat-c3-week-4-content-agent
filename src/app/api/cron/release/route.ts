import { NextResponse } from "next/server";
import { runRelease } from "@/lib/publish/worker";
import { verifyCronSecret } from "@/lib/crypto";
import { drainPipeline } from "@/lib/pipeline/dispatch";
import { logError } from "@/lib/log";



export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  try {
    const [release, pipeline] = await Promise.allSettled([runRelease(), drainPipeline()]);
    if (release.status === "rejected") throw release.reason;
    if (pipeline.status === "rejected") throw pipeline.reason;
    const result = release.value, advanced = pipeline.value;

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
