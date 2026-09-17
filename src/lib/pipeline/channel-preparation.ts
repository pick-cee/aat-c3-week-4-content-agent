import type { ChannelName } from "@/lib/db/types";

/** Prepare independent channels concurrently; retries skip outputs already saved. */
export async function prepareMissingChannels<T>(requested: ChannelName[], saved: ChannelName[], prepare: (channel: ChannelName) => Promise<T>): Promise<void> {
  const done = new Set(saved);
  const results = await Promise.allSettled(requested.filter(channel => !done.has(channel)).map(prepare));
  // Wait for every save before releasing the lease, including when a sibling fails.
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
