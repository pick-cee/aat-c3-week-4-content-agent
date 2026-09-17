import { serviceClient, table } from "./db/client";
import { deriveChannelState, type ChannelState } from "./pipeline/channel-state";
import type { ChannelName, ChannelOutputStatus, PublishStatus } from "./db/types";
interface Tiles { needsYou: number | null; scheduledToday: number | null; failedBlocked: number | null; spentCents: number | null; spendComplete: boolean }
export async function loadTiles(): Promise<Tiles> {
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

export async function loadChannelStates(ids: string[]): Promise<Map<string, ChannelState[]>> {
  const byRequest = new Map<string, ChannelState[]>();

  if (!ids.length) return byRequest;
  try {
    const db = serviceClient();
    const [outputs, queue] = await Promise.all([
      db.from(table("channel_outputs")).select("request_id, channel, status, version").in("request_id", ids),
      db.from(table("publish_queue")).select("request_id, channel, status, created_at").in("request_id", ids),
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
