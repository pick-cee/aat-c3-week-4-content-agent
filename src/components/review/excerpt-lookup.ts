import type { Source } from "@/lib/db/types";

/** Maps source ids to what a citation tooltip needs. */
export type ReviewExcerpt = { id: string; source_id: string; text: string };

export function buildExcerptLookup(sources: Source[], excerpts: ReviewExcerpt[] = []) {
  const lookup: Record<
    string,
    { text: string; sourceTitle: string | null; sourceUrl: string; siteName: string | null }
  > = {};

  for (const excerpt of excerpts) {
    const source = sources.find(s => s.id === excerpt.source_id);
    if (!source) continue;
    lookup[excerpt.id] = {
      text: excerpt.text,
      sourceTitle: source.title,
      sourceUrl: source.url,
      siteName: source.site_name,
    };
  }

  return lookup;
}
