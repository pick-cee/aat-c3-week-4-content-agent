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
import { ViewPostButton } from "@/components/view-post-button";
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

  const [queueResult, connectorResult, deliveryResult, requestResult, outputResult] =
    await Promise.all([
    db
      .from(table("publish_queue"))
      .select("*")
      .neq("status", "cancelled")
      .order("scheduled_for", { ascending: true })
      .limit(100),
    db.from(table("connector_view")).select("*"),
    db.from(table("publish_deliveries")).select("queue_id, status"),
    db.from(table("content_requests")).select("id, idea, slug"),
    // The post text itself. A handoff item in this queue is waiting for a
    // person to paste it somewhere, and the queue showed no content at all.
    db
      .from(table("channel_outputs"))
      .select("id, subject, body, hashtags")
      .in("status", ["approved", "draft"]),
  ]);

  const items = (queueResult.data ?? []) as unknown as PublishQueueItem[];
  const connectors = (connectorResult.data ?? []) as unknown as ConnectorStatusRow[];
  const deliveries = (deliveryResult.data ?? []) as unknown as Pick<
    PublishDelivery,
    "queue_id" | "status"
  >[];
  const outputs = new Map(
    (outputResult.data ?? []).map((o) => [
      o.id as string,
      {
        subject: o.subject as string | null,
        body: o.body as string,
        hashtags: (o.hashtags ?? []) as string[],
      },
    ]),
  );
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
    // A held item has no time. It sorts after everything with one, rather
    // than to 1970, which is where `new Date(null)` would put it.
    const at = a.scheduled_for ? new Date(a.scheduled_for).getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.scheduled_for ? new Date(b.scheduled_for).getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });

  /**
   * Only a DELIVERING channel can be "not ready".
   *
   * LinkedIn and X are handoff: the system emails a copy-ready packet to a
   * person who posts it, which is the whole point of §2.11 and needs no
   * platform credential. Listing them as "not connected" describes a problem
   * that does not exist and makes the design look broken.
   */
  const problems = connectors.filter(
    (c) => c.kind === "delivering" && c.status !== "connected",
  );

  /**
   * Four groups, by what the reader has to do about them.
   *
   * A single sorted list put a failed send and a scheduled one in the same
   * visual bucket, so "is anything wrong" meant reading every row.
   */
  const needsAction = sorted.filter((i) =>
    ["uncertain", "failed", "blocked_not_connected", "partially_delivered", "held"].includes(
      i.status,
    ),
  );
  const awaitingPost = sorted.filter((i) => i.status === "awaiting_manual_post");
  const dueSoon = sorted.filter((i) => ["queued", "publishing"].includes(i.status));
  const done = sorted.filter((i) =>
    ["published", "posted_manually", "published_dry_run"].includes(i.status),
  );
  const needingYou = needsAction.length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Publishing queue</h1>
        </div>
        <Link href="/" className="btn btn-ghost btn-sm">
          Back to dashboard
        </Link>
      </div>

      {/* What is actually happening, before any list.
          The page opened with a connector table and a stack of identical
          cards, so "is anything stuck" took reading every row. */}
      <div className="lead">
        <div className="lead-primary">
          <span className={`lead-value ${needingYou > 0 ? "is-problem" : "is-clear"}`}>
            {needingYou}
          </span>
          <span className="lead-label">
            {needingYou === 0
              ? "Nothing is stuck"
              : needingYou === 1
                ? "item needs you"
                : "items need you"}
          </span>
        </div>
        <div className="lead-aside">
          <div className="lead-stat">
            <span className="lead-stat-value">{dueSoon.length}</span>
            <span className="lead-stat-label">Waiting to send</span>
          </div>
          <div className="lead-stat">
            <span className="lead-stat-value">{awaitingPost.length}</span>
            <span className="lead-stat-label">For you to post</span>
          </div>
          <div className="lead-stat">
            <span className="lead-stat-value">{done.length}</span>
            <span className="lead-stat-label">Gone out</span>
          </div>
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
          and go out when the connection is restored, nothing is marked published that did not
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
                {/* A handoff channel has no account to connect, so a
                    connection pill would report a problem it cannot have.
                    What matters for handoff is that someone is assigned to
                    post it, and that is checked at send time. */}
                {connector.kind === "handoff" ? (
                  <span className="pill pill-info tiny" title="You post this one. At its scheduled time the system emails you a copy-ready packet, and it is only marked posted once you confirm with a URL.">
                    Posted by you
                  </span>
                ) : (
                  <ConnectorStatusPill status={connector.status} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
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
      ) : (
        <>
          {/* Grouped by what the reader has to DO, rather than one flat list
              where a stuck item looks like a scheduled one. */}
          <QueueSection
            title="Needs you"
            tone="danger"
            items={needsAction}
            requests={requests}
            outputs={outputs}
            counts={counts}
            canApprove={canApprove(profile)}
          />
          <QueueSection
            title="For you to post"
            items={awaitingPost}
            requests={requests}
            outputs={outputs}
            counts={counts}
            canApprove={canApprove(profile)}
          />
          <QueueSection
            title="Waiting to send"
            items={dueSoon}
            requests={requests}
            outputs={outputs}
            counts={counts}
            canApprove={canApprove(profile)}
          />
          <QueueSection
            title="Gone out"
            items={done}
            requests={requests}
            outputs={outputs}
            counts={counts}
            canApprove={canApprove(profile)}
          />
        </>
      )}
    </>
  );
}

/** A named group of queue items. Renders nothing when the group is empty. */
function QueueSection({
  title,
  tone,
  items,
  requests,
  outputs,
  counts,
  canApprove,
}: {
  title: string;
  tone?: "danger";
  items: PublishQueueItem[];
  requests: Map<string, string>;
  outputs: Map<string, { subject: string | null; body: string; hashtags: string[] }>;
  counts: Map<string, { delivered: number; total: number; failed: number; skipped: number }>;
  canApprove: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <section className="section">
      <div className="section-head">
        <h2
          className="section-title"
          style={tone === "danger" ? { color: "var(--danger)" } : undefined}
        >
          {title}
        </h2>
        <span className="tiny dim">{items.length}</span>
      </div>
      <div className="rows">
        {items.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            idea={requests.get(item.request_id) ?? "Untitled request"}
            output={outputs.get(item.channel_output_id) ?? null}
            counts={counts.get(item.id) ?? null}
            canApprove={canApprove}
          />
        ))}
      </div>
    </section>
  );
}

function QueueRow({
  item,
  idea,
  output,
  counts,
  canApprove,
}: {
  item: PublishQueueItem;
  idea: string;
  output: { subject: string | null; body: string; hashtags: string[] } | null;
  counts: { delivered: number; total: number; failed: number; skipped: number } | null;
  canApprove: boolean;
}) {
  const urgent = item.status === "uncertain";
  const attention = ["failed", "blocked_not_connected", "partially_delivered"].includes(
    item.status,
  );

  return (
    <div
      className={`row-item ${urgent ? "is-attention" : attention ? "is-waiting" : ""}`}
      style={{ alignItems: "flex-start" }}
    >
      <div className="row-between grow" style={{ alignItems: "flex-start" }}>
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
            {item.scheduled_for
              ? `Scheduled ${formatWhen(item.scheduled_for)}`
              : "No send time yet"}
            {item.attempt > 0 && ` · attempt ${item.attempt} of ${item.max_attempts}`}
            {item.handoff_sent_at && ` · packet sent ${formatWhen(item.handoff_sent_at)}`}
            {item.published_at && ` · sent ${formatWhen(item.published_at)}`}
            {item.confirmed_at && ` · confirmed ${formatWhen(item.confirmed_at)}`}
          </div>

          {/* Opens in a dialog rather than expanding inline: a long post
              used to push every row beneath it off the screen. */}
          {item.kind === "handoff" &&
            output &&
            ["awaiting_manual_post", "queued", "held"].includes(item.status) && (
              <div className="mt-1">
                <ViewPostButton
                  channelLabel={CHANNEL_LABELS[item.channel]}
                  subject={output.subject}
                  body={output.body}
                  hashtags={output.hashtags}
                  weighted={item.channel === "x"}
                />
              </div>
            )}

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
