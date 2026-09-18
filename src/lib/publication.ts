import { serviceClient, table } from "./db/client";

export function mayShowPublicArticle(status: string, deletedAt: string | null, approved: boolean, channelRevision = false): boolean {
  return !deletedAt && approved && (["scheduled", "publishing", "published"].includes(status) ||
    (channelRevision && ["adapting", "failed", "budget_exceeded"].includes(status)));
}

/** Only the exact article version attached to a human-approved channel is public. */
export async function hasPublicApproval(requestId: string, versionId: string): Promise<boolean> {
  const { data, error } = await serviceClient().from(table("channel_outputs"))
    .select("id").eq("request_id", requestId).eq("article_version_id", versionId)
    .eq("status", "approved").limit(1);
  if (error) throw new Error("Could not verify article approval.");
  return Boolean(data?.length);
}
