import { redirect } from "next/navigation";
import Link from "next/link";
import { currentProfile, serviceClient, canApprove, table } from "@/lib/db/client";
import {
  PublishStatusPill,
  publishSortWeight,
  ConnectorStatusPill,
  CHANNEL_LABELS,
  formatWhen,
} from "@/components/status";
import { QueueActions } from "@/components/queue-actions";
import { UncertainDeliveries } from "@/components/uncertain-deliveries";
import type {
  ConnectorStatusRow,
  PublishDelivery,
  PublishQueueItem,
} from "@/lib/db/types";

/**
 * The publishing queue. DESIGN.md §16.
 *
 * "Grouped by scheduled time, with connector status banners at the top and
 * per-item cost... A handoff item shows who it went to and whether they have
 * confirmed. `uncertain` items pin to the top in red with their two buttons."
 */

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const profile = await currentProfile();
  if (!profile) redirect("/");

  const db = serviceClient();

  const [queueResult, connectorResult, deliveryResult, requestResult] = await Promise.all([
    db
      .from(table("publish_queue"))
      .select("*")
      .neq("status", "cancelled")
      .order("scheduled_for", { ascending: true })
      .limit(100),
    db.from(table("connector_view")).select("*"),
    db.from(table("publish_deliveries")).select("queue_id, status"),
    db.from(table("content_requests")).select("id, idea, slug"),
  ]);

  const items = (queueResult.data ?? []) as unknown as PublishQueueItem[];
  const connectors = (connectorResult.data ?? []) as unknown as ConnectorStatusRow[];
  const deliveries = (deliveryResult.data ?? []) as unknown as Pick<
    PublishDelivery,
    "queue_id" | "status"
  >[];
  const requests = new Map(
    (requestResult.data ?? []).map((r) => [r.id as string, r.idea as string]),
  );

  // Real counts per queue row, so a fan-out never renders as a bare status
  // word (§5.12).
  const counts = new Map<string, { delivered: number; total: number; failed: number; skipped: number }>();
  for (const delivery of deliveries) {
    const current = counts.get(delivery.queue_id) ?? {
      delivered: 0,
      total: 0,
      failed: 0,
      skipped: 0,
    };
    current.total++;
    if (delivery.status === "sent" || delivery.status === "delivered") current.delivered++;
    else if (delivery.status === "failed") current.failed++;
    else if (delivery.status === "skipped_no_optin") current.skipped++;
    counts.set(delivery.queue_id, current);
  }

  const sorted = [...items].sort((a, b) => {
    const weight = publishSortWeight(a.status) - publishSortWeight(b.status);
    if (weight !== 0) return weight;
    return new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime();
  });

  const problems = connectors.filter((c) => c.status !== "connected");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Publishing queue</h1>
          <p>What is scheduled, what went out, and what did not.</p>
        </div>
      </div>

      <UncertainDeliveries />

      {/* Connector status banners at the top (§16). A channel with no
          authorised connector is honest about it rather than failing later. */}
      {problems.length > 0 && (
        <div className="alert alert-warn">
          <strong>
            {problems.length} channel{problems.length === 1 ? "" : "s"} not ready:
          </strong>{" "}
          {problems.map((c) => CHANNEL_LABELS[c.channel]).join(", ")}. Items for these stay queued
          and go out when the connection is restored — nothing is marked published that did not
          happen.
        </div>
      )}

      <div className="card mb-3">
        <div className="card-head">
          <h2 style={{ fontSize: 15 }}>Channels</h2>
        </div>
        <div className="card-pad">
          <div className="row" style={{ gap: 16 }}>
            {connectors.map((connector) => (
              <div key={connector.id} className="row" style={{ gap: 7 }}>
                <span className="small strong">{CHANNEL_LABELS[connector.channel]}</span>
                <ConnectorStatusPill status={connector.status} />
                <span className="tiny dim">
                  {connector.kind === "handoff" ? "handed to a person" : "sent by the system"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="card">
          <div className="empty">
            <h3>Nothing in the queue</h3>
            <p>
              Approved content appears here. Nothing reaches this queue without a person
              approving it first.
            </p>
            <Link href="/" className="btn">
              Back to the dashboard
            </Link>
          </div>
        </div>
      ) : (
        <div className="stack">
          {sorted.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              idea={requests.get(item.request_id) ?? "—"}
              counts={counts.get(item.id) ?? null}
              canApprove={canApprove(profile)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function QueueRow({
  item,
  idea,
  counts,
  canApprove,
}: {
  item: PublishQueueItem;
  idea: string;
  counts: { delivered: number; total: number; failed: number; skipped: number } | null;
  canApprove: boolean;
}) {
  const urgent = item.status === "uncertain";
  const attention = ["failed", "blocked_not_connected", "partially_delivered"].includes(
    item.status,
  );

  return (
    <div
      className="card card-pad"
      style={{
        borderLeft: urgent
          ? "3px solid var(--danger)"
          : attention
            ? "3px solid var(--warn)"
            : undefined,
      }}
    >
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, marginBottom: 4 }}>
            <span className="strong small">{CHANNEL_LABELS[item.channel]}</span>
            <PublishStatusPill
              status={item.status}
              deliveredOf={item.kind === "delivering" ? counts : null}
            />
            {item.kind === "handoff" && (
              <span className="pill pill-info tiny">handed to a person</span>
            )}
          </div>

          <div className="small">
            <Link href={`/requests/${item.request_id}`}>{truncate(idea, 80)}</Link>
          </div>

          <div className="tiny dim mt-1">
            Scheduled {formatWhen(item.scheduled_for)}
            {item.attempt > 0 && ` · attempt ${item.attempt} of ${item.max_attempts}`}
            {item.handoff_sent_at && ` · packet sent ${formatWhen(item.handoff_sent_at)}`}
            {item.published_at && ` · sent ${formatWhen(item.published_at)}`}
            {item.confirmed_at && ` · confirmed ${formatWhen(item.confirmed_at)}`}
          </div>

          {item.platform_url && (
            <div className="tiny mt-1">
              <a href={item.platform_url} target="_blank" rel="noopener noreferrer">
                View the live post ↗
              </a>
            </div>
          )}

          {item.last_error && (
            <div
              className={`alert small mt-1 mb-0 ${urgent ? "alert-error" : "alert-warn"}`}
            >
              {item.last_error}
            </div>
          )}
        </div>

        <QueueActions item={item} canApprove={canApprove} />
      </div>
    </div>
  );
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}
