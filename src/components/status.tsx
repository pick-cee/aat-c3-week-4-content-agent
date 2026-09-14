import type {
  ChannelName,
  ConnectorStatus,
  FetchStatus,
  PublishStatus,
  RequestStatus,
} from "@/lib/db/types";

/**
 * Status rendering. DESIGN.md §16, §17.
 *
 * Every distinction the data model makes has to survive to the screen. The
 * whole point of `uncertain` being separate from `failed`, and
 * `posted_manually` being separate from `published`, is lost if they render
 * the same way — so the mapping lives in one place and each state gets its own
 * words.
 */

type Tone = "ok" | "warn" | "danger" | "info" | "accent";

function Pill({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      <span className="dot" />
      {children}
    </span>
  );
}

// ─── Request status ─────────────────────────────────────────────────────────

const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone; title: string }> = {
  draft: { label: "Draft", tone: "info", title: "Not submitted yet." },
  researching: { label: "Researching", tone: "accent", title: "Finding and reading sources." },
  plan_review: {
    label: "Needs you",
    tone: "warn",
    title: "Confirm the sources and pick an angle.",
  },
  drafting: { label: "Writing", tone: "accent", title: "Writing the article." },
  evaluating: { label: "Evaluating", tone: "accent", title: "Grading the draft against the rubric." },
  revising: { label: "Revising", tone: "accent", title: "Rewriting the sections that failed." },
  adapting: { label: "Adapting", tone: "accent", title: "Producing the channel versions." },
  content_review: {
    label: "Needs you",
    tone: "warn",
    title: "Review the article and approve each channel.",
  },
  scheduled: { label: "Scheduled", tone: "ok", title: "Approved and waiting to go out." },
  publishing: { label: "Publishing", tone: "accent", title: "Going out now." },
  published: { label: "Published", tone: "ok", title: "Delivered, with an identifier on record." },
  needs_human: {
    label: "Needs a person",
    tone: "warn",
    title: "This cannot proceed automatically. Nothing was published.",
  },
  failed: { label: "Failed", tone: "danger", title: "Stopped at a named step." },
  budget_exceeded: {
    label: "Over budget",
    tone: "danger",
    title: "Stopped before spending more. Everything produced so far is intact.",
  },
  cancelled: { label: "Cancelled", tone: "info", title: "Stopped by a person." },
};

export function RequestStatusPill({ status }: { status: RequestStatus }) {
  const meta = REQUEST_STATUS[status];
  return (
    <Pill tone={meta.tone} title={meta.title}>
      {meta.label}
    </Pill>
  );
}

/** Failed and blocked sort above everything (§16). Lower number sorts first. */
export function requestSortWeight(status: RequestStatus): number {
  switch (status) {
    case "failed":
    case "budget_exceeded":
      return 0;
    case "needs_human":
      return 1;
    case "plan_review":
    case "content_review":
      return 2;
    case "researching":
    case "drafting":
    case "evaluating":
    case "revising":
    case "adapting":
    case "publishing":
      return 3;
    case "scheduled":
      return 4;
    case "published":
      return 5;
    default:
      return 6;
  }
}

// ─── Publish status ─────────────────────────────────────────────────────────

/**
 * `published`, `posted_manually`, `published_dry_run` and `partially_delivered`
 * are four different things and are labelled as four different things (§2.9,
 * §9, §19.6).
 */
const PUBLISH_STATUS: Record<PublishStatus, { label: string; tone: Tone; title: string }> = {
  queued: { label: "Queued", tone: "info", title: "Waiting for its scheduled time." },
  publishing: { label: "Sending", tone: "accent", title: "In flight now." },
  published: {
    label: "Published",
    tone: "ok",
    title: "The provider returned an identifier, which is stored on this row.",
  },
  published_dry_run: {
    label: "Dry run",
    tone: "info",
    title: "DEMO_MODE was on. Nothing reached a real recipient. This is not a real publish.",
  },
  awaiting_manual_post: {
    label: "Awaiting posting",
    tone: "warn",
    title:
      "The copy-ready packet was sent to whoever posts it. This is NOT published, however long it sits.",
  },
  posted_manually: {
    label: "Posted by hand",
    tone: "ok",
    title:
      "A person posted this and confirmed with a URL. A real post — and also not something this system did.",
  },
  failed: { label: "Failed", tone: "danger", title: "It did not go out." },
  uncertain: {
    label: "Outcome unknown",
    tone: "danger",
    title:
      "We cannot tell whether this sent. It will NOT be retried automatically — tell us which it was.",
  },
  blocked_not_connected: {
    label: "Not connected",
    tone: "warn",
    title: "No authorised account for this channel. The item stays queued.",
  },
  partially_delivered: {
    label: "Partly delivered",
    tone: "warn",
    title: "Some recipients received it and some did not. The real counts are shown.",
  },
  cancelled: { label: "Cancelled", tone: "info", title: "Stopped by a person." },
};

export function PublishStatusPill({
  status,
  deliveredOf,
}: {
  status: PublishStatus;
  /** Real counts for a fan-out, never a status word alone (§5.12). */
  deliveredOf?: { delivered: number; total: number; failed: number; skipped: number } | null;
}) {
  const meta = PUBLISH_STATUS[status];

  return (
    <span className="row" style={{ gap: 8 }}>
      <Pill tone={meta.tone} title={meta.title}>
        {meta.label}
      </Pill>
      {deliveredOf && (
        <span className="tiny muted">
          {deliveredOf.delivered} of {deliveredOf.total} delivered
          {deliveredOf.failed > 0 && `, ${deliveredOf.failed} failed`}
          {deliveredOf.skipped > 0 && `, ${deliveredOf.skipped} skipped for consent`}
        </span>
      )}
    </span>
  );
}

/** `uncertain` items pin to the top in red (§16). */
export function publishSortWeight(status: PublishStatus): number {
  switch (status) {
    case "uncertain":
      return 0;
    case "failed":
      return 1;
    case "blocked_not_connected":
    case "partially_delivered":
      return 2;
    case "awaiting_manual_post":
      return 3;
    case "publishing":
      return 4;
    case "queued":
      return 5;
    default:
      return 6;
  }
}

// ─── Fetch status ───────────────────────────────────────────────────────────

/**
 * `empty` and `fetch_failed` are different values because a dead fetch and a
 * genuinely empty result producing the same message was useless (§5.4). Both
 * appear in the source list.
 */
const FETCH_STATUS: Record<FetchStatus, { label: string; tone: Tone; title: string }> = {
  pending: { label: "Not read yet", tone: "info", title: "Queued for fetching." },
  ok: { label: "Read", tone: "ok", title: "Fetched successfully and indexed." },
  fetch_failed: {
    label: "Could not fetch",
    tone: "danger",
    title: "The page was never retrieved — a 404, a timeout or a refusal.",
  },
  blocked: { label: "Blocked", tone: "danger", title: "The site refused the request." },
  paywalled: {
    label: "Paywalled",
    tone: "warn",
    title: "A subscription prompt came back instead of the article.",
  },
  empty: {
    label: "No article text",
    tone: "warn",
    title: "The page WAS fetched — there was simply nothing on it. Not the same as a failed fetch.",
  },
  too_large: {
    label: "Truncated",
    tone: "warn",
    title: "Longer than the limit. Truncated and still used.",
  },
  unsupported_type: {
    label: "Not readable",
    tone: "warn",
    title: "Not an HTML, PDF or text document.",
  },
  redirected_offsite: {
    label: "Redirected",
    tone: "warn",
    title: "Ended up on a different site. Kept and flagged for you to judge.",
  },
};

export function FetchStatusPill({ status }: { status: FetchStatus }) {
  const meta = FETCH_STATUS[status];
  return (
    <Pill tone={meta.tone} title={meta.title}>
      {meta.label}
    </Pill>
  );
}

// ─── Connectors ─────────────────────────────────────────────────────────────

const CONNECTOR_STATUS: Record<ConnectorStatus, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "ok" },
  not_connected: { label: "Not connected", tone: "warn" },
  expired: { label: "Expired", tone: "danger" },
  revoked: { label: "Revoked", tone: "danger" },
  error: { label: "Error", tone: "danger" },
};

export function ConnectorStatusPill({ status }: { status: ConnectorStatus }) {
  const meta = CONNECTOR_STATUS[status];
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

// ─── Channels ───────────────────────────────────────────────────────────────

export const CHANNEL_LABELS: Record<ChannelName, string> = {
  linkedin: "LinkedIn",
  x: "X",
  newsletter: "Newsletter",
};

export function ChannelChip({
  channel,
  tone = "info",
  suffix,
}: {
  channel: ChannelName;
  tone?: Tone;
  suffix?: string;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {CHANNEL_LABELS[channel]}
      {suffix && <span style={{ opacity: 0.75 }}> {suffix}</span>}
    </span>
  );
}

// ─── Cost ───────────────────────────────────────────────────────────────────

/**
 * A total missing a call reads "at least $X"; one that could not be read at
 * all reads "—", never "0" (§5.3, §17).
 */
export function Cost({
  cents,
  complete = true,
  budget,
}: {
  cents: number | null | undefined;
  complete?: boolean;
  budget?: number | null;
}) {
  if (cents == null) {
    return (
      <span className="dim" title="This figure could not be read, so it is not shown as zero.">
        —
      </span>
    );
  }

  const value = `$${(cents / 100).toFixed(2)}`;
  const over = budget != null && cents > budget;

  return (
    <span
      className={over ? "strong" : undefined}
      style={over ? { color: "var(--danger)" } : undefined}
      title={
        complete
          ? undefined
          : "At least this much — one or more calls could not be written to the cost log, so the real total may be higher."
      }
    >
      {complete ? "" : "at least "}
      {value}
      {budget != null && <span className="dim"> of ${(budget / 100).toFixed(2)}</span>}
    </span>
  );
}

/** Relative time, for "how long has this been sitting". */
export function Ago({ iso }: { iso: string }) {
  const then = new Date(iso).getTime();
  const minutes = Math.floor((Date.now() - then) / 60_000);

  const label =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : minutes < 1_440
          ? `${Math.floor(minutes / 60)}h ago`
          : `${Math.floor(minutes / 1_440)}d ago`;

  return (
    <span className="dim tiny" title={new Date(iso).toLocaleString("en-GB")}>
      {label}
    </span>
  );
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
