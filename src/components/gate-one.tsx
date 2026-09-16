"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setSourceIncluded,
  chooseAngle,
  replanAngles,
} from "@/app/actions/requests";
import { FetchStatusPill } from "./status";
import { SOURCE_RELEVANCE_THRESHOLD, MAX_REPLANS_BEFORE_CONFIRM } from "@/lib/constants";
import type { Angle, ContentRequest, OutlineSection, Source } from "@/lib/db/types";

/**
 * Gate one: sources and angle. DESIGN.md §14.1.
 *
 * "One screen, two steps. Sources first... The reviewer unchecks anything they
 * do not want... Angles second: three cards... Pick one, or Re-plan with a
 * note."
 *
 * This is what makes "reviewed source material" true (§2.1): the default path
 * costs one button press, and the capability to exclude a bad source before it
 * can contaminate a draft is the point.
 */

export function GateOne({
  request,
  sources,
  angles,
}: {
  request: ContentRequest;
  sources: Source[];
  angles: Angle[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [replanNote, setReplanNote] = useState("");
  const [showReplan, setShowReplan] = useState(false);

  /**
   * Which angle is being written, if any.
   *
   * A single `pending` flag spun the button on all three cards at once, which
   * looks like the system is doing three things and is not obviously
   * recoverable. Tracking WHICH one was chosen lets the others simply
   * disable — the difference between "this is happening" and "everything is
   * happening".
   */
  const [choosingAngleId, setChoosingAngleId] = useState<string | null>(null);

  const usable = sources.filter((s) =>
    ["ok", "too_large", "redirected_offsite"].includes(s.fetch_status),
  );
  const unusable = sources.filter(
    (s) => !["ok", "too_large", "redirected_offsite"].includes(s.fetch_status),
  );
  const included = usable.filter((s) => s.included);

  const liveAngles = angles.filter((a) => !a.invalidated);
  const deadAngles = angles.filter((a) => a.invalidated);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  }

  return (
    <div className="stack mb-3">
      {error && <div className="alert alert-error">{error}</div>}

      {/* ── Sources ── */}
      <div className="card">
        <div className="card-head">
          <h2 style={{ fontSize: 15 }}>1. Confirm the sources</h2>
          <span className="tiny dim">
            {included.length} of {usable.length} selected
          </span>
        </div>

        <div>
          {usable.map((source) => {
            const lowRelevance =
              source.relevance_score != null &&
              source.relevance_score < SOURCE_RELEVANCE_THRESHOLD;

            return (
              <div
                key={source.id}
                style={{
                  padding: "12px 20px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  opacity: source.included ? 1 : 0.55,
                }}
              >
                <input
                  type="checkbox"
                  checked={source.included}
                  disabled={pending}
                  onChange={(e) =>
                    act(() => setSourceIncluded(request.id, source.id, e.target.checked))
                  }
                  style={{ marginTop: 4, flex: "none" }}
                  aria-label={`Include ${source.title ?? source.url}`}
                />

                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="strong small"
                    >
                      {source.title ?? source.url}
                    </a>
                    {source.origin === "seed" && (
                      <span className="pill pill-accent tiny">You supplied this</span>
                    )}
                    {source.fetch_status !== "ok" && (
                      <FetchStatusPill status={source.fetch_status} />
                    )}
                    {source.embed_failed && (
                      <span
                        className="pill pill-warn tiny"
                        title={
                          source.embed_retryable
                            ? "The indexing service is rate limiting us. This source is queued to be tried again automatically."
                            : "This source could not be indexed, so it will not be picked automatically. It is still here if you want it."
                        }
                      >
                        {source.embed_retryable ? "Indexing, will retry" : "Not indexed"}
                      </span>
                    )}
                  </div>

                  <div className="tiny dim" style={{ marginTop: 2 }}>
                    {source.site_name}
                    {source.published_at &&
                      ` · ${new Date(source.published_at).toLocaleDateString("en-GB")}`}
                    {source.markdown_chars != null &&
                      ` · ${source.markdown_chars.toLocaleString()} characters`}
                    {source.from_cache && " · from cache"}
                  </div>

                  {source.fetch_error && (
                    <div className="tiny muted" style={{ marginTop: 3 }}>
                      {source.fetch_error}
                    </div>
                  )}
                </div>

                <div className="nowrap tiny" style={{ flex: "none", textAlign: "right" }}>
                  {source.relevance_score != null ? (
                    <span
                      className={lowRelevance ? "muted" : "strong"}
                      title="How closely this source matches the request, by vector similarity."
                    >
                      {(source.relevance_score * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="dim" title="Relevance could not be scored.">
                      —
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* A source that could not be read is a ROW, not an absence (§5.4).
              They appear here, uncheckable, and on the public source list. */}
          {unusable.length > 0 && (
            <div style={{ padding: "12px 20px", background: "var(--surface-2)" }}>
              <div className="tiny strong mb-1">
                {unusable.length} source{unusable.length === 1 ? "" : "s"} could not be used
              </div>
              {unusable.map((source) => (
                <div key={source.id} className="row tiny muted" style={{ marginBottom: 4 }}>
                  <FetchStatusPill status={source.fetch_status} />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {source.title ?? source.url}
                  </span>
                  {source.fetch_error && <span className="dim">— {source.fetch_error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Angles ── */}
      <div className="card">
        <div className="card-head">
          <h2 style={{ fontSize: 15 }}>2. Pick an angle</h2>
          <span className="tiny dim">One is written in full after you choose</span>
        </div>

        <div className="card-pad">
          {liveAngles.length === 0 ? (
            <div className="empty">
              <h3>No angles available</h3>
              <p>Every angle relied on a source that has been removed. Re-plan to continue.</p>
            </div>
          ) : (
            <div className="stack">
              {liveAngles.map((angle) => (
                <AngleCard
                  key={angle.id}
                  angle={angle}
                  sources={sources}
                  chosen={choosingAngleId === angle.id}
                  // Any click disables the rest; only the chosen one spins.
                  disabled={pending || choosingAngleId !== null}
                  onChoose={() => {
                    setChoosingAngleId(angle.id);
                    act(async () => {
                      const result = await chooseAngle(request.id, angle.id);
                      // Clear only on failure. On success the page navigates,
                      // and clearing would flash the buttons back to ready.
                      if (!result.ok) setChoosingAngleId(null);
                      return result;
                    });
                  }}
                />
              ))}
            </div>
          )}

          {/* Excluding a source after angles exist invalidates any angle that
              used it. The card greys out with the reason (§14.1). */}
          {deadAngles.length > 0 && (
            <div className="mt-2">
              {deadAngles.map((angle) => (
                <div
                  key={angle.id}
                  className="card card-pad mb-1"
                  style={{ opacity: 0.6, background: "var(--surface-2)" }}
                >
                  <div className="strong small">{angle.headline}</div>
                  <div className="tiny muted mt-1">{angle.invalidated_reason}</div>
                </div>
              ))}
            </div>
          )}

          <div className="divider" />

          {showReplan ? (
            <div>
              <label htmlFor="replan">What should be different?</label>
              <textarea
                id="replan"
                value={replanNote}
                onChange={(e) => setReplanNote(e.target.value)}
                rows={2}
                placeholder="These are all too general, I want something about the cost side."
              />
              <div className="btn-row mt-1">
                <button
                  className="btn btn-sm btn-primary"
                  disabled={pending || !replanNote.trim()}
                  onClick={() =>
                    act(async () => {
                      const result = await replanAngles(request.id, replanNote);
                      if (result.ok) {
                        setShowReplan(false);
                        setReplanNote("");
                      }
                      return result;
                    })
                  }
                >
                  {pending ? <span className="spin" /> : "Re-plan"}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setShowReplan(false)}>
                  Cancel
                </button>
              </div>
              {/* Every re-plan costs money and the button shows the amount;
                  after two, the third says what has been spent (§14.1). */}
              {request.replans >= MAX_REPLANS_BEFORE_CONFIRM && (
                <div className="alert alert-warn small mt-2 mb-0">
                  You have re-planned {request.replans} times already. Each one costs about $0.01
                  and none of them is free.
                </div>
              )}
            </div>
          ) : (
            <button className="btn btn-sm" onClick={() => setShowReplan(true)} disabled={pending}>
              None of these, re-plan (about $0.01)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AngleCard({
  angle,
  sources,
  chosen,
  disabled,
  onChoose,
}: {
  angle: Angle;
  sources: Source[];
  /** This is the one being written — only this card shows a spinner. */
  chosen: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const outline = (angle.outline ?? []) as OutlineSection[];

  // Which sources this angle would lean on, so "reviewed source material" is
  // visible at the moment of choosing rather than implied.
  const sourceCount = new Set(
    sources
      .filter((s) => angle.excerpt_ids.length > 0)
      .map((s) => s.id),
  ).size;

  return (
    <div className="card card-pad" style={{ boxShadow: "none" }}>
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="pill pill-info tiny mb-1">{angle.label}</div>
          <h3 style={{ fontSize: 16, marginBottom: 6 }}>{angle.headline}</h3>
          {angle.rationale && <p className="small muted mb-2">{angle.rationale}</p>}

          <ol className="small muted" style={{ margin: "0 0 10px", paddingLeft: 18 }}>
            {outline.map((section, i) => (
              <li key={i} style={{ marginBottom: 3 }}>
                <span className="strong" style={{ color: "var(--text)" }}>
                  {section.heading}
                </span>
                {section.intent && <span className="dim">, {section.intent}</span>}
              </li>
            ))}
          </ol>

          <div className="row tiny dim">
            <span>
              Keyword: <span className="mono">{angle.primary_keyword}</span>
            </span>
            {angle.secondary_keywords.length > 0 && (
              <span>· Also: {angle.secondary_keywords.slice(0, 3).join(", ")}</span>
            )}
            <span>
              · Draws on {angle.excerpt_ids.length} excerpt
              {angle.excerpt_ids.length === 1 ? "" : "s"}
              {sourceCount > 0 && ` across ${sourceCount} sources`}
            </span>
          </div>
        </div>

        <button
          className="btn btn-primary btn-sm"
          onClick={onChoose}
          disabled={disabled}
          style={{ flex: "none" }}
        >
          {chosen ? (
            <>
              <span className="spin" /> Writing…
            </>
          ) : (
            "Write this one"
          )}
        </button>
      </div>
    </div>
  );
}
