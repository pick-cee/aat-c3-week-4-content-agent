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
import { UncertainDeliveries } from "@/components/uncertain-deliveries";
import {
  deriveChannelState,
  summariseChannels,
  type ChannelState,
} from "@/lib/pipeline/channel-state";
import type {
  ChannelName,
  ChannelOutputStatus,
  ContentRequest,
  PublishStatus,
} from "@/lib/db/types";

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

  const [tiles, requests, channelStates] = await Promise.all([
    loadTiles(),
    loadRequests(),
    loadChannelStates(),
  ]);

  const sorted = [...requests].sort((a, b) => {
    const weight = requestSortWeight(a.status) - requestSortWeight(b.status);
    if (weight !== 0) return weight;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const attention = sorted.filter((r) =>
    ["failed", "budget_exceeded", "needs_human"].includes(r.status),
  );

  // The lead answers one question: is anything waiting on me right now.
  const waiting = tiles.needsYou;
  const problems = tiles.failedBlocked;
  const leadTone =
    waiting == null ? "" : waiting > 0 ? "is-waiting" : problems ? "is-problem" : "is-clear";

  const live = sorted.filter(
    (r) => !["failed", "budget_exceeded"].includes(r.status) && !attention.includes(r),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
        </div>
        <Link href="/requests/new" className="btn btn-primary">
          New request
        </Link>
      </div>

      {/* One figure with weight, the rest as supporting detail.
          Four equal tiles gave "Spent this month" the same prominence as
          "Needs you", which is how a dashboard ends up saying nothing. */}
      <div className="lead">
        <div className="lead-primary">
          <span className={`lead-value ${leadTone}`}>
            {waiting == null ? "—" : waiting}
          </span>
          <span className="lead-label">
            {waiting == null
              ? "The count could not be read"
              : waiting === 0
                ? "Nothing is waiting on you"
                : waiting === 1
                  ? "request is waiting on you"
                  : "requests are waiting on you"}
          </span>
        </div>

        <div className="lead-aside">
          <Link href="/queue" className="lead-stat">
            <span className="lead-stat-value">
              {tiles.scheduledToday == null ? "—" : tiles.scheduledToday}
            </span>
            <span className="lead-stat-label">Scheduled today</span>
          </Link>
          <Link href="/?filter=attention" className="lead-stat">
            <span className={`lead-stat-value ${problems ? "is-problem" : ""}`}>
              {problems == null ? "—" : problems}
            </span>
            <span className="lead-stat-label">Failed or blocked</span>
          </Link>
          <div className="lead-stat">
            <span className="lead-stat-value">
              <Cost cents={tiles.spentCents} complete={tiles.spendComplete} />
            </span>
            <span className="lead-stat-label">Spent this month</span>
          </div>
        </div>
      </div>

      <UncertainDeliveries />

      {/* Problems first and visibly, as a list rather than a card in a card. */}
      {attention.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="section-title" style={{ color: "var(--danger)" }}>
              Needs attention
            </h2>
            <span className="tiny dim">{attention.length}</span>
          </div>
          <div className="rows">
            {attention.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                channels={channelStates.get(request.id) ?? []}
              />
            ))}
          </div>
        </section>
      )}

      {sorted.length === 0 ? (
        <div className="empty">
          {/* Empty states say what is missing and what to do, never a bare
              zero (§16). */}
          <h3>No requests yet</h3>
          <p>
            Submit an idea or a source URL and the system will research it, draft an article,
            grade its own draft and prepare each channel for review.
          </p>
          <Link href="/requests/new" className="btn btn-primary">
            Create the first request
          </Link>
        </div>
      ) : (
        live.length > 0 && (
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">In flight</h2>
              <span className="tiny dim">{live.length}</span>
            </div>
            <div className="rows">
              {live.map((request) => (
                <RequestRow
                  key={request.id}
                  request={request}
                  channels={channelStates.get(request.id) ?? []}
                />
              ))}
            </div>
          </section>
        )
      )}
    </>
  );
}

/**
 * One request as a row in a list.
 *
 * Was a bordered card in a stack of bordered cards, which put three requests
 * on a screen and made every one look equally urgent. A row shares a single
 * hairline rule and carries its state as a coloured stripe, which is read
 * before any text is.
 */
function RequestRow({
  request,
  channels,
}: {
  request: ContentRequest;
  channels: ChannelState[];
}) {
  const attention = ["failed", "budget_exceeded"].includes(request.status);
  const needsYou = ["plan_review", "content_review", "needs_human"].includes(request.status);

  return (
    <div
      className={`row-item ${attention ? "is-attention" : needsYou ? "is-waiting" : ""}`}
    >
      <div className="row-main">
        <div className="row-title">
          <Link href={`/requests/${request.id}`}>{request.idea}</Link>
        </div>
        <div className="row-sub">
          {/* What the channels actually did, in words. The request status alone
              said "Scheduled" for a request with nothing left to schedule. */}
          {channels.length > 0 && <>{summariseChannels(channels)} · </>}
          <Ago iso={request.updated_at} />
          {" · "}
          <Cost
            cents={request.actual_cost_cents}
            complete={request.cost_complete}
            budget={request.budget_cents}
          />
          {request.failure_reason && attention && (
            <> · <span style={{ color: "var(--danger)" }}>{truncate(request.failure_reason, 90)}</span></>
          )}
        </div>
      </div>

      <div className="row-side">
        {/* Each channel carries its OWN outcome. Three neutral chips beside a
            single "Scheduled" said nothing true about a request whose
            newsletter had sent, whose LinkedIn was cancelled and whose X post
            was rejected. */}
        <span className="row" style={{ gap: 4 }}>
          {channels.map((state) => (
            <ChannelChip
              key={state.channel}
              channel={state.channel}
              tone={state.tone}
              suffix={state.detail}
            />
          ))}
        </span>
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

/**
 * Per-channel outcomes for every request on the page, in two queries.
 *
 * The queue row wins where one exists, because it records what the worker
 * actually did; the channel_output status covers everything before that.
 */
async function loadChannelStates(): Promise<Map<string, ChannelState[]>> {
  const byRequest = new Map<string, ChannelState[]>();

  try {
    const db = serviceClient();
    const [outputs, queue] = await Promise.all([
      db.from(table("channel_outputs")).select("request_id, channel, status, version"),
      db.from(table("publish_queue")).select("request_id, channel, status, created_at"),
    ]);

    // Latest output per request+channel: re-adaptation adds a version rather
    // than overwriting.
    const latestOutput = new Map<string, { status: ChannelOutputStatus; version: number }>();
    for (const row of outputs.data ?? []) {
      const key = `${row.request_id}:${row.channel}`;
      const seen = latestOutput.get(key);
      const version = row.version as number;
      if (!seen || version > seen.version) {
        latestOutput.set(key, { status: row.status as ChannelOutputStatus, version });
      }
    }

    // Newest queue row per request+channel, for the same reason.
    const latestQueue = new Map<string, { status: PublishStatus; at: string }>();
    for (const row of queue.data ?? []) {
      const key = `${row.request_id}:${row.channel}`;
      const seen = latestQueue.get(key);
      const at = row.created_at as string;
      if (!seen || at > seen.at) {
        latestQueue.set(key, { status: row.status as PublishStatus, at });
      }
    }

    for (const [key, output] of latestOutput) {
      const [requestId, channel] = key.split(":") as [string, ChannelName];
      const state = deriveChannelState(
        channel,
        output.status,
        latestQueue.get(key)?.status ?? null,
      );
      const list = byRequest.get(requestId) ?? [];
      list.push(state);
      byRequest.set(requestId, list);
    }

    // Worst news first, matching how everything else on this page sorts.
    for (const list of byRequest.values()) list.sort((a, b) => a.weight - b.weight);
  } catch {
    // A failed read means no chips rather than wrong chips.
  }

  return byRequest;
}

async function loadRequests(): Promise<ContentRequest[]> {
  try {
    const { data } = await serviceClient()
      .from(table("content_requests"))
      .select("*")
      .neq("status", "cancelled")
      // Deleted requests live in the recycle bin. Their costs still count
      // towards the month; their rows do not clutter the work list.
      .is("deleted_at", null)
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
