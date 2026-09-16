import { FetchStatusPill } from "../status";
import type { Source } from "@/lib/db/types";

/**
 * What the article was written from, including what could not be read.
 *
 * Presentational only: it takes sources and renders them. No actions, no
 * request, no approval state — so it can be shown anywhere a source list is
 * useful without dragging the review screen's concerns along with it.
 */
export function SourcesPanel({ sources }: { sources: Source[] }) {
  const included = sources.filter((s) => s.included);
  const excluded = sources.filter((s) => !s.included);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="tiny muted mb-0">
        {included.length} source{included.length === 1 ? "" : "s"} informed this article. Every
        citation in the text resolves to one of them.
      </p>

      {included.map((source) => (
        <div key={source.id} className="small">
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            {source.title ?? source.url}
          </a>
          <div className="tiny dim">
            {source.site_name}
            {source.relevance_score != null &&
              ` · ${(source.relevance_score * 100).toFixed(0)}% relevance`}
          </div>
        </div>
      ))}

      {/* A source that could not be read is a row, not an absence (§5.4). */}
      {excluded.length > 0 && (
        <>
          <div className="divider" />
          <div className="tiny strong">Not used</div>
          {excluded.map((source) => (
            <div key={source.id} className="tiny muted">
              <FetchStatusPill status={source.fetch_status} />{" "}
              {source.title ?? source.url}
              {source.excluded_reason && <span className="dim">, {source.excluded_reason}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
