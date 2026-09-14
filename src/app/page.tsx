import Link from "next/link";
import { serviceClient, currentProfile, table } from "@/lib/db/client";
import {
  RequestStatusPill,
  requestSortWeight,
  ChannelChip,
  Cost,
  Ago,
} from "@/components/status";
import { Landing } from "@/components/landing";
import { DeleteRequest } from "@/components/delete-request";
import type { ContentRequest } from "@/lib/db/types";

/**
 * The dashboard. DESIGN.md §16.
 *
 * "A row of tiles first: Needs you · Scheduled today · Failed or blocked ·
 * Spent this month. Each is a number and a label, each links to a filtered
 * list. Below, request cards... Failed and blocked sort above everything.
 * Nothing on this screen requires reading a paragraph to know what is going
 * on."
 */

export const dynamic = "force-dynamic";

interface Tiles {
  needsYou: number | null;
  scheduledToday: number | null;
  failedBlocked: number | null;
  spentCents: number | null;
  spendComplete: boolean;
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await currentProfile();
  const { error } = await searchParams;

  // A signed-out visitor gets the landing page with a real stored sample, no
  // account required (§20). A failed sign-in lands back here with its reason,
  // rather than a button that silently did nothing.
  if (!profile) return <Landing error={error} />;

  const [tiles, requests] = await Promise.all([loadTiles(), loadRequests()]);

  const sorted = [...requests].sort((a, b) => {
    const weight = requestSortWeight(a.status) - requestSortWeight(b.status);
    if (weight !== 0) return weight;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const attention = sorted.filter((r) =>
    ["failed", "budget_exceeded", "needs_human"].includes(r.status),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Everything in flight, with what needs you first.</p>
        </div>
        <Link href="/requests/new" className="btn btn-primary">
          New request
        </Link>
      </div>

      <div className="tiles">
        <Tile
          href="/?filter=needs-you"
          value={tiles.needsYou}
          label="Needs you"
          tone={tiles.needsYou && tiles.needsYou > 0 ? "warn" : undefined}
        />
        <Tile href="/queue" value={tiles.scheduledToday} label="Scheduled today" />
        <Tile
          href="/?filter=attention"
          value={tiles.failedBlocked}
          label="Failed or blocked"
          tone={tiles.failedBlocked && tiles.failedBlocked > 0 ? "attention" : undefined}
        />
        <div className="tile">
          <div className="tile-value" style={{ fontSize: 24 }}>
            <Cost cents={tiles.spentCents} complete={tiles.spendComplete} />
          </div>
          <div className="tile-label">Spent this month</div>
        </div>
      </div>

      {attention.length > 0 && (
        <div className="card mb-3" style={{ borderColor: "#fecaca" }}>
          <div className="card-head" style={{ background: "var(--danger-soft)" }}>
            <h2 style={{ fontSize: 15, color: "var(--danger)" }}>
              {attention.length} {attention.length === 1 ? "request needs" : "requests need"} attention
            </h2>
          </div>
          <div style={{ padding: "4px 0" }}>
            {attention.map((request) => (
              <div
                key={request.id}
                className="row-between"
                style={{ padding: "10px 20px", borderBottom: "1px solid var(--border)" }}
              >
                <div style={{ minWidth: 0 }}>
                  <Link href={`/requests/${request.id}`} className="strong">
                    {truncate(request.idea, 70)}
                  </Link>
                  {request.failure_reason && (
                    <div className="tiny muted" style={{ marginTop: 2 }}>
                      {truncate(request.failure_reason, 120)}
                    </div>
                  )}
                </div>
                <RequestStatusPill status={request.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="card">
          {/* Empty states say what is missing and what to do, never a bare
              zero (§16). */}
          <div className="empty">
            <h3>No requests yet</h3>
            <p>
              Submit an idea or a source URL and the system will research it, draft an article,
              grade its own draft and prepare each channel for review.
            </p>
            <Link href="/requests/new" className="btn btn-primary">
              Create the first request
            </Link>
          </div>
        </div>
      ) : (
        <div className="stack">
          {sorted.map((request) => (
            <RequestCard key={request.id} request={request} />
          ))}
        </div>
      )}
    </>
  );
}

function Tile({
  href,
  value,
  label,
  tone,
}: {
  href: string;
  value: number | null;
  label: string;
  tone?: "warn" | "attention";
}) {
  // A tile reading "0 failed" when the count could not be loaded is a lie, so
  // it reads "—" with a tooltip instead (§16, §17).
  const unknown = value == null;

  return (
    <Link
      href={href}
      className={`tile ${unknown ? "tile-unknown" : tone ? `tile-${tone}` : ""}`}
      title={unknown ? "This count could not be read, so it is not shown as zero." : undefined}
    >
      <div className="tile-value">{unknown ? "—" : value}</div>
      <div className="tile-label">{label}</div>
    </Link>
  );
}

function RequestCard({ request }: { request: ContentRequest }) {
  const attention = ["failed", "budget_exceeded"].includes(request.status);
  const needsYou = ["plan_review", "content_review", "needs_human"].includes(request.status);

  return (
    <div
      className={`request-card ${attention ? "needs-attention" : needsYou ? "needs-you" : ""}`}
    >
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="request-title">
          <Link href={`/requests/${request.id}`}>{truncate(request.idea, 90)}</Link>
        </div>
        <div className="request-meta">
          {request.target_audience && <>For {truncate(request.target_audience, 50)} · </>}
          <Ago iso={request.updated_at} />
          {" · "}
          <Cost
            cents={request.actual_cost_cents}
            complete={request.cost_complete}
            budget={request.budget_cents}
          />
        </div>

        {request.failure_reason && attention && (
          <div className="alert alert-error mt-1 mb-0 small">{request.failure_reason}</div>
        )}

        <div className="chips">
          {request.channels.map((channel) => (
            <ChannelChip key={channel} channel={channel} />
          ))}
        </div>
      </div>

      <div className="stack" style={{ alignItems: "flex-end", gap: 8, flex: "none" }}>
        <RequestStatusPill status={request.status} />
        <NextAction request={request} />
        <DeleteRequest requestId={request.id} compact />
      </div>
    </div>
  );
}

/** The next action as a button, so nothing requires reading to act on (§16). */
function NextAction({ request }: { request: ContentRequest }) {
  const href = `/requests/${request.id}`;

  switch (request.status) {
    case "plan_review":
      return (
        <Link href={href} className="btn btn-sm btn-primary">
          Review sources
        </Link>
      );
    case "content_review":
      return (
        <Link href={href} className="btn btn-sm btn-primary">
          Review content
        </Link>
      );
    case "failed":
    case "budget_exceeded":
    case "needs_human":
      return (
        <Link href={href} className="btn btn-sm">
          See what happened
        </Link>
      );
    case "scheduled":
      return (
        <Link href="/queue" className="btn btn-sm btn-ghost">
          View queue
        </Link>
      );
    default:
      return (
        <Link href={href} className="btn btn-sm btn-ghost">
          Open
        </Link>
      );
  }
}

// ─── Data ───────────────────────────────────────────────────────────────────

/**
 * Every tile can independently be unknown. Returning null rather than 0 on a
 * read failure is what lets the UI honour "unknown is not zero" (§17).
 */
async function loadTiles(): Promise<Tiles> {
  try {
    const { data, error } = await serviceClient().rpc("dashboard_counts");
    if (error || !data) {
      return {
        needsYou: null,
        scheduledToday: null,
        failedBlocked: null,
        spentCents: null,
        spendComplete: true,
      };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return {
        needsYou: null,
        scheduledToday: null,
        failedBlocked: null,
        spentCents: null,
        spendComplete: true,
      };
    }

    return {
      needsYou: Number(row.needs_you),
      scheduledToday: Number(row.scheduled_today),
      failedBlocked: Number(row.failed_blocked),
      spentCents: Math.round(Number(row.spent_month_cents)),
      // null from bool_and means no rows this month, which is complete.
      spendComplete: row.spend_complete !== false,
    };
  } catch {
    return {
      needsYou: null,
      scheduledToday: null,
      failedBlocked: null,
      spentCents: null,
      spendComplete: true,
    };
  }
}

async function loadRequests(): Promise<ContentRequest[]> {
  try {
    const { data } = await serviceClient()
      .from(table("content_requests"))
      .select("*")
      .neq("status", "cancelled")
      .order("updated_at", { ascending: false })
      .limit(50);

    return (data ?? []) as unknown as ContentRequest[];
  } catch {
    return [];
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}
