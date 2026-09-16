import type { Source } from "@/lib/db/types";

/** Maps source ids to what a citation tooltip needs. */
export function buildExcerptLookup(sources: Source[]) {
  // The excerpt text itself is not loaded into this component — the tooltip
  // falls back to naming the source, which is what the reviewer needs to click
  // through. Loading every excerpt body would make this page much heavier for
  // information that is one click away.
  const lookup: Record<
    string,
    { text: string; sourceTitle: string | null; sourceUrl: string; siteName: string | null }
  > = {};

  for (const source of sources) {
    lookup[source.id] = {
      text: "",
      sourceTitle: source.title,
      sourceUrl: source.url,
      siteName: source.site_name,
    };
  }

  return lookup;
}
