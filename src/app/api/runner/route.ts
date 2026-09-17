import { NextResponse } from "next/server";
import { currentProfile, serviceClient, table } from "@/lib/db/client";
import { verifyCronSecret } from "@/lib/crypto";
import { kickoffPipeline } from "@/lib/pipeline/kickoff";
import { drainPipeline } from "@/lib/pipeline/dispatch";
import { z } from "zod";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request) {
  const isCron = verifyCronSecret(request.headers.get("authorization"));
  if (!isCron && !await currentProfile()) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (isCron && !body?.requestId) return NextResponse.json(await drainPipeline());
  const parsed = idSchema.safeParse(body?.requestId);
  if (!parsed.success) return NextResponse.json({ error: "A valid requestId is required." }, { status: 400 });
  const { data, error } = await serviceClient().from(table("content_requests"))
    .select("id, status").eq("id",parsed.data).is("deleted_at",null).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not read this request." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Request not found." }, { status: 404 });
  kickoffPipeline(parsed.data);
  return NextResponse.json({ accepted: true, status: data.status }, { status: 202 });
}

export async function GET(request: Request) {
  if (!await currentProfile()) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const parsed = idSchema.safeParse(new URL(request.url).searchParams.get("requestId"));
  if (!parsed.success) return NextResponse.json({ error: "Invalid requestId." }, { status: 400 });
  const { data, error } = await serviceClient().from(table("content_requests"))
    .select("status, current_step, step_attempts, step_started_at, retry_after, runner_lease_until, actual_cost_cents, updated_at")
    .eq("id",parsed.data).is("deleted_at",null).maybeSingle();
  if (error) return NextResponse.json({ error: "Progress is temporarily unavailable." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Request not found." }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
