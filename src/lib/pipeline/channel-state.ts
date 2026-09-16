import type { ChannelName, ChannelOutputStatus, PublishStatus, Tone } from "@/lib/db/types";

/**
 * What actually happened to each channel of a request.
 *
 * The dashboard showed the REQUEST's status and three neutral channel chips,
 * so a request whose newsletter had published, whose LinkedIn had been
 * cancelled and whose X post had been rejected still read "Scheduled" with
 * three identical grey chips. Every one of those chips was wrong about its own
 * channel, and the single status word was wrong about all three.
 *
 * A request is one row; a channel is its own story. This derives the second
 * from the first so a reader sees what is true per channel.
 */

export interface ChannelState {
  channel: ChannelName;
  label: string;
  tone: Tone;
  /** Short enough to sit inside a pill next to the channel name. */
  detail: string;
  /** Sorts the worst news first, the way the dashboard orders everything. */
  weight: number;
}

/**
 * The queue row is the authority once one exists, because it records what the
 * worker actually did. Before that the channel_output status is all there is:
 * drafted, approved but not yet queued, or rejected.
 */
export function deriveChannelState(
  channel: ChannelName,
  outputStatus: ChannelOutputStatus | null,
  queueStatus: PublishStatus | null,
): ChannelState {
  const base = { channel, label: CHANNEL_SHORT[channel] };

  if (queueStatus) {
    switch (queueStatus) {
      case "published":
        return { ...base, tone: "ok", detail: "sent", weight: 6 };
      case "published_dry_run":
        return { ...base, tone: "ok", detail: "dry run", weight: 6 };
      case "posted_manually":
        return { ...base, tone: "ok", detail: "posted", weight: 6 };
      case "partially_delivered":
        return { ...base, tone: "warn", detail: "partly sent", weight: 1 };
      case "awaiting_manual_post":
        return { ...base, tone: "warn", detail: "for you to post", weight: 2 };
      case "publishing":
        return { ...base, tone: "accent", detail: "sending", weight: 4 };
      case "queued":
        return { ...base, tone: "info", detail: "scheduled", weight: 5 };
      case "held":
        return { ...base, tone: "warn", detail: "needs a time", weight: 2 };
      case "uncertain":
        return { ...base, tone: "danger", detail: "unknown", weight: 0 };
      case "failed":
        return { ...base, tone: "danger", detail: "failed", weight: 0 };
      case "blocked_not_connected":
        return { ...base, tone: "danger", detail: "not connected", weight: 1 };
      case "cancelled":
        return { ...base, tone: "info", detail: "cancelled", weight: 7 };
    }
  }

  switch (outputStatus) {
    case "approved":
      // Approved with no queue row means held without a send time, which the
      // queue shows; here it is simply not out yet.
      return { ...base, tone: "info", detail: "approved", weight: 5 };
    case "rejected":
      return { ...base, tone: "info", detail: "rejected", weight: 7 };
    case "format_failed":
      return { ...base, tone: "warn", detail: "format problem", weight: 2 };
    case "draft":
      return { ...base, tone: "warn", detail: "needs review", weight: 3 };
    default:
      // No output produced yet: the pipeline has not reached adaptation.
      return { ...base, tone: "info", detail: "not ready", weight: 8 };
  }
}

const CHANNEL_SHORT: Record<ChannelName, string> = {
  linkedin: "LinkedIn",
  x: "X",
  newsletter: "Newsletter",
};

/**
 * One line summarising every channel, for a reader who wants the answer
 * without decoding chips.
 *
 * Says what happened rather than naming a state: "1 sent, 1 cancelled,
 * 1 rejected" is checkable; "Scheduled" is not.
 */
export function summariseChannels(states: ChannelState[]): string {
  if (states.length === 0) return "No channels";

  const counts = new Map<string, number>();
  for (const s of states) counts.set(s.detail, (counts.get(s.detail) ?? 0) + 1);

  return [...counts.entries()].map(([detail, n]) => `${n} ${detail}`).join(", ");
}
