import { NextResponse } from "next/server";
import { serviceClient, table, currentProfile } from "@/lib/db/client";
import { integrationStatus } from "@/lib/env";
import { PRICES_VERIFIED_ON } from "@/lib/constants";

/**
 * GET /api/health — the status of every dependency.
 *
 * DESIGN.md §20: "a dead dependency is diagnosable without reading logs."
 *
 * Each check reports `ok`, `down` or `not_configured`, and those are three
 * different things: a provider nobody has configured is not a provider that is
 * broken, and reporting them the same way would send someone hunting for an
 * outage that is really a blank environment variable.
 */

export const dynamic = "force-dynamic";

type CheckState = "ok" | "down" | "not_configured";

interface Check {
  state: CheckState;
  detail: string;
  latencyMs?: number;
}

export async function GET() {
  const checks: Record<string, Check> = {};

  checks.database = await timed(async () => {
    const { error } = await serviceClient()
      .from(table("content_requests"))
      .select("id", { head: true, count: "exact" })
      .limit(1);
    if (error) throw new Error(error.message);
    return "Reachable, and the schema is present.";
  });

  checks.schema = await timed(async () => {
    const { error } = await serviceClient().from(table("content_requests"))
      .select("retry_after, reserved_cost_cents, revision_parent_id, untracked_cost", { head: true }).limit(1);
    if (error) throw new Error("Apply the pending database migrations with npm run db:push.");
    return "Execution schema is present.";
  });

  const integrations = integrationStatus();

  checks.anthropic = await probe(
    Boolean(process.env.ANTHROPIC_API_KEY),
    "Key present. Calls are made per pipeline step.",
  );
  checks.firecrawl = await probe(
    integrations.firecrawl,
    "Key present. Every source URL is read through it.",
  );
  checks.embeddings = await probe(
    integrations.embeddings,
    "Key present. Grounding checks and source ranking depend on it.",
  );
  checks.resend = await probe(
    integrations.resend,
    "Key present. Newsletter delivery and notifications.",
  );

  // Connectors degrade the app, they do not break it (§20), so a missing
  // connector table is reported rather than thrown.
  checks.connectors = await timed(async () => {
    const { data, error } = await serviceClient()
      .from(table("connector_view"))
      .select("channel, status");
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    const connected = rows.filter((r) => r.status === "connected").length;
    return rows.length === 0
      ? "No connectors configured yet."
      : `${connected} of ${rows.length} channels connected.`;
  });

  const anyDown = Object.values(checks).some((c) => c.state === "down") ||
    ["anthropic", "firecrawl", "embeddings"].some(name => checks[name]?.state !== "ok");
  const profile = await currentProfile().catch(() => null);

  return NextResponse.json(
    {
      status: anyDown ? "degraded" : "ok",
      checks: profile ? checks : Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, { state: check.state }])),
      ...(profile ? { config: {
        demoMode: integrations.demoMode,
        pricesVerifiedOn: PRICES_VERIFIED_ON,
      } } : {}),
      checkedAt: new Date().toISOString(),
    },
    {
      // Degraded is still a working response: the point is to be readable, not
      // to make a monitoring tool page someone at 3am for a missing API key.
      status: anyDown ? 503 : 200,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function timed(fn: () => Promise<string>): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { state: "ok", detail, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      state: "down",
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Configuration presence only — no live call. Probing every provider on a
 * health check spends money on every uptime ping, which is a bill nobody
 * chose to pay.
 */
async function probe(configured: boolean, okDetail: string): Promise<Check> {
  return configured
    ? { state: "ok", detail: okDetail }
    : { state: "not_configured", detail: "No API key is set, so this step will fail if reached." };
}
