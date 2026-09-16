"use client";

/** Which panel of the review screen is showing. */
export type Tab = "draft" | "channels" | "evaluation" | "image" | "sources" | "versions";

/** A tab with an optional count. Presentational. */
export function TabButton({
  id,
  tab,
  setTab,
  label,
  badge,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  label: string;
  badge?: number;
}) {
  return (
    <button
      className="tab"
      aria-selected={tab === id}
      role="tab"
      onClick={() => setTab(id)}
      type="button"
    >
      {label}
      {badge != null && badge > 0 && <span className="dim tiny">{badge}</span>}
    </button>
  );
}

// ─── Channels ───────────────────────────────────────────────────────────────
