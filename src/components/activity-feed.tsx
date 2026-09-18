import { Ago } from "./status";
import type { ActivityLogEntry } from "@/lib/db/types";

/**
 * The activity log. DESIGN.md §5.15.
 *
 * "Every state transition writes a row. Every failure writes a row with a
 * plain-language message a non-engineer can read and a detail an engineer can
 * debug from."
 *
 * Both audiences are served here: the message is always visible, the detail
 * is behind a disclosure.
 */

export function ActivityFeed({ entries, revisionNotes = {} }: { entries: ActivityLogEntry[]; revisionNotes?: Record<string, string> }) {
  if (entries.length === 0) return null;

  // Entries arrive newest first (the query orders by created_at desc).
  const latest = entries[0];

  return (
    <details className="card mb-3">
      <summary
        className="card-head"
        style={{ cursor: "pointer", listStyle: "none", borderBottom: "none" }}
      >
        <div className="min-w-0">
          <h2 style={{ fontSize: 14 }}>Activity</h2>
          {/* The latest event, without opening anything. Collapsed behind a
              summary at the bottom of a long page, this log was effectively
              invisible, a founder had no idea it existed, let alone that it
              answers "what just happened". */}
          {latest && (
            <div className="tiny dim truncate-2" style={{ marginTop: 2 }}>
              {latest.message}
            </div>
          )}
        </div>
        <span className="tiny dim nowrap">{entries.length} entries</span>
      </summary>

      <div style={{ borderTop: "1px solid var(--border)" }}>
        {entries.map((entry) => (
          <div
            key={entry.id}
            style={{
              padding: "9px 20px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <span
              className="dot"
              style={{
                marginTop: 7,
                flex: "none",
                background:
                  entry.level === "error"
                    ? "var(--danger)"
                    : entry.level === "warn"
                      ? "var(--warn)"
                      : "var(--border-strong)",
              }}
            />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small">{entry.message}</div>
              {revisionNotes[entry.id] && (
                <p className="small muted mt-1" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  Revision note: {revisionNotes[entry.id]}
                </p>
              )}
              {entry.detail && (
                <details>
                  <summary className="tiny dim" style={{ cursor: "pointer" }}>
                    detail
                  </summary>
                  <pre
                    className="preview tiny mono mt-1"
                    style={{ overflow: "auto", maxHeight: 200 }}
                  >
                    {JSON.stringify(entry.detail, null, 2)}
                  </pre>
                </details>
              )}
            </div>
            <span className="nowrap" style={{ flex: "none" }}>
              {entry.step && <span className="tiny dim">{entry.step} · </span>}
              <Ago iso={entry.created_at} />
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
