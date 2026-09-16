import { formatWhen } from "../status";
import type { ArticleVersion, Evaluation } from "@/lib/db/types";

/**
 * The review history. Versions are never overwritten (§5.7), so this is the
 * record of every draft and how each one scored.
 *
 * Presentational only.
 */
export function VersionsPanel({
  versions,
  evaluations,
}: {
  versions: ArticleVersion[];
  evaluations: Evaluation[];
}) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="tiny muted mb-0">
        Versions are never overwritten. This is the review history: every draft, and how each one
        scored.
      </p>

      {versions.map((version) => {
        const evaluation = evaluations.find((e) => e.article_version_id === version.id);
        return (
          <div key={version.id} className="row-between small">
            <div>
              <span className="strong">v{version.version}</span>
              <span className="dim"> · {version.origin.replace("_", " ")}</span>
              <div className="tiny dim">
                {version.word_count} words · {formatWhen(version.created_at)}
              </div>
            </div>
            {evaluation && (
              <span
                className={`pill tiny ${
                  evaluation.status === "pass"
                    ? "pill-ok"
                    : evaluation.status === "not_evaluated"
                      ? "pill-info"
                      : "pill-warn"
                }`}
              >
                {evaluation.status === "not_evaluated" ? "not evaluated" : evaluation.status}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
