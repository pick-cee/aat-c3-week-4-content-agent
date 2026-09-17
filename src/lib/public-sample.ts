import { serviceClient, table } from "./db/client";
import { hasPublicApproval } from "./publication";
interface Sample {
  slug: string;
  title: string;
  metaDescription: string | null;
  idea: string;
  sourceCount: number;
  citedSentences: number;
  channelCount: number;
}

export async function loadSample(): Promise<Sample | null> {
  try {
    const db = serviceClient();

    // Explicit column list, never `select *`, on anything a signed-out visitor
    // can reach (§19.4).
    const { data: request } = await db
      .from(table("content_requests"))
      .select("id, slug, idea").is("deleted_at", null)
      .not("slug", "is", null)
      .in("status", ["scheduled", "publishing", "published"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!request?.slug) return null;

    const [versionResult, sourceResult, channelResult] = await Promise.all([
      db
        .from(table("article_versions"))
        .select("id, title, meta_description, claim_map")
        .eq("request_id", request.id as string)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from(table("sources"))
        .select("id", { count: "exact", head: true })
        .eq("request_id", request.id as string)
        .eq("included", true),
      db
        .from(table("channel_outputs"))
        .select("id", { count: "exact", head: true })
        .eq("request_id", request.id as string),
    ]);

    if (!versionResult.data || !(await hasPublicApproval(request.id as string, versionResult.data.id as string))) return null;

    const claimMap = (versionResult.data.claim_map ?? []) as unknown[];

    return {
      slug: request.slug as string,
      title: versionResult.data.title as string,
      metaDescription: versionResult.data.meta_description as string | null,
      idea: request.idea as string,
      sourceCount: sourceResult.count ?? 0,
      citedSentences: claimMap.length,
      channelCount: channelResult.count ?? 0,
    };
  } catch {
    // The landing page renders regardless. A dead dependency must degrade the
    // app, not break it (§20).
    return null;
  }
}
