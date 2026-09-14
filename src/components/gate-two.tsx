"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveChannel,
  rejectChannel,
  requestRevision,
  saveHumanEdit,
  chooseImage,
} from "@/app/actions/approvals";
import { ArticleView } from "./article-view";
import { EvaluationReport } from "./evaluation-report";
import { FetchStatusPill, CHANNEL_LABELS, formatWhen } from "./status";
import type {
  Angle,
  ArticleVersion,
  ChannelOutput,
  ContentRequest,
  Evaluation,
  ImageCandidate,
  Source,
} from "@/lib/db/types";

/**
 * Gate two: content. DESIGN.md §14.2.
 *
 * "Left: the article, rendered, with citation superscripts and the amber/red
 * highlighting. Right: a tabbed panel with the evaluation report, the channel
 * outputs, the image candidates, the source list, and the version history."
 *
 * "Actions: Approve per channel (channels are approved independently),
 * Request revision with a note, Edit the article directly, Reject."
 */

type Tab = "evaluation" | "channels" | "image" | "sources" | "versions";

export function GateTwo({
  request,
  version,
  versions,
  evaluations,
  outputs,
  images,
  sources,
  canApprove,
}: {
  request: ContentRequest;
  version: ArticleVersion;
  versions: ArticleVersion[];
  evaluations: Evaluation[];
  outputs: ChannelOutput[];
  images: ImageCandidate[];
  sources: Source[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("evaluation");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(version.body_md);
  const [revisionNote, setRevisionNote] = useState("");
  const [showRevision, setShowRevision] = useState(false);

  const evaluation = evaluations.find((e) => e.article_version_id === version.id) ?? null;

  // The latest output per channel: re-adaptation creates a new version rather
  // than overwriting.
  const latestOutputs = Object.values(
    outputs.reduce<Record<string, ChannelOutput>>((acc, output) => {
      const existing = acc[output.channel];
      if (!existing || output.version > existing.version) acc[output.channel] = output;
      return acc;
    }, {}),
  );

  const excerptLookup = buildExcerptLookup(sources);
  const readOnly = request.status !== "content_review";

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  }

  return (
    <>
      {error && <div className="alert alert-error">{error}</div>}

      {readOnly && (
        <div className="alert alert-info">
          This request is {request.status.replace("_", " ")}. The content below is what was
          approved.
        </div>
      )}

      <div className="split">
        {/* ── Left: the article ── */}
        <div className="card">
          <div className="card-head">
            <div>
              <h2 style={{ fontSize: 15 }}>{version.title}</h2>
              <div className="tiny dim">
                Version {version.version} · {version.origin.replace("_", " ")} ·{" "}
                {version.word_count} words
              </div>
            </div>
            {!readOnly && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setEditBody(version.body_md);
                  setEditing(!editing);
                }}
              >
                {editing ? "Cancel edit" : "Edit"}
              </button>
            )}
          </div>

          <div className="card-pad">
            {editing ? (
              <>
                <textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={28}
                  className="mono"
                  style={{ fontSize: 13.5, lineHeight: 1.65 }}
                />
                {/* A human edit re-runs the computed checks, INCLUDING
                    grounding. The check does not become optional because a
                    person did the typing (§11.4). */}
                <div className="alert alert-warn small mt-2 mb-2">
                  Saving re-runs the grounding checks. Any factual sentence you add without a
                  citation marker will be flagged — you can accept it, but you will see it.
                </div>
                <div className="row">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={pending}
                    onClick={() =>
                      act(async () => {
                        const result = await saveHumanEdit(request.id, editBody);
                        if (result.ok) setEditing(false);
                        return result;
                      })
                    }
                  >
                    {pending ? <span className="spin" /> : "Save as a new version"}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <ArticleView
                bodyMd={version.body_md}
                claimMap={version.claim_map}
                excerpts={excerptLookup}
                sources={sources}
              />
            )}
          </div>
        </div>

        {/* ── Right: the panel ── */}
        <div className="card" style={{ position: "sticky", top: 72 }}>
          <div className="tabs">
            <TabButton id="evaluation" tab={tab} setTab={setTab} label="Evaluation" />
            <TabButton
              id="channels"
              tab={tab}
              setTab={setTab}
              label="Channels"
              badge={latestOutputs.length}
            />
            <TabButton id="image" tab={tab} setTab={setTab} label="Image" badge={images.length} />
            <TabButton
              id="sources"
              tab={tab}
              setTab={setTab}
              label="Sources"
              badge={sources.length}
            />
            <TabButton
              id="versions"
              tab={tab}
              setTab={setTab}
              label="History"
              badge={versions.length}
            />
          </div>

          <div className="card-pad" style={{ maxHeight: "70vh", overflowY: "auto" }}>
            {tab === "evaluation" && <EvaluationReport evaluation={evaluation} />}

            {tab === "channels" && (
              <ChannelPanel
                outputs={latestOutputs}
                request={request}
                canApprove={canApprove}
                readOnly={readOnly}
                pending={pending}
                onApprove={(outputId, when, note) =>
                  act(() => approveChannel(request.id, outputId, when, note))
                }
                onReject={(outputId, note) =>
                  act(() => rejectChannel(request.id, outputId, note))
                }
              />
            )}

            {tab === "image" && (
              <ImagePanel
                images={images}
                pending={pending}
                readOnly={readOnly}
                onChoose={(imageId) => act(() => chooseImage(request.id, imageId))}
              />
            )}

            {tab === "sources" && <SourcePanel sources={sources} />}

            {tab === "versions" && <VersionPanel versions={versions} evaluations={evaluations} />}
          </div>

          {!readOnly && (
            <div className="card-pad" style={{ borderTop: "1px solid var(--border)" }}>
              {showRevision ? (
                <>
                  <label htmlFor="revision">What needs to change?</label>
                  <textarea
                    id="revision"
                    value={revisionNote}
                    onChange={(e) => setRevisionNote(e.target.value)}
                    rows={2}
                  />
                  <div className="row mt-1">
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={pending || !revisionNote.trim()}
                      onClick={() => act(() => requestRevision(request.id, revisionNote))}
                    >
                      Send for revision
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setShowRevision(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="btn btn-sm"
                  style={{ width: "100%" }}
                  onClick={() => setShowRevision(true)}
                >
                  Request a revision
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function TabButton({
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

function ChannelPanel({
  outputs,
  request,
  canApprove,
  readOnly,
  pending,
  onApprove,
  onReject,
}: {
  outputs: ChannelOutput[];
  request: ContentRequest;
  canApprove: boolean;
  readOnly: boolean;
  pending: boolean;
  onApprove: (outputId: string, when: string | null, note?: string) => void;
  onReject: (outputId: string, note: string) => void;
}) {
  if (outputs.length === 0) {
    return <p className="small muted">No channel versions were produced.</p>;
  }

  return (
    <div className="stack">
      {outputs.map((output) => (
        <ChannelCard
          key={output.id}
          output={output}
          request={request}
          canApprove={canApprove}
          readOnly={readOnly}
          pending={pending}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
    </div>
  );
}

function ChannelCard({
  output,
  request,
  canApprove,
  readOnly,
  pending,
  onApprove,
  onReject,
}: {
  output: ChannelOutput;
  request: ContentRequest;
  canApprove: boolean;
  readOnly: boolean;
  pending: boolean;
  onApprove: (outputId: string, when: string | null, note?: string) => void;
  onReject: (outputId: string, note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [showReject, setShowReject] = useState(false);

  const isHandoff = output.channel === "linkedin" || output.channel === "x";
  const failures = (output.format_check?.checks ?? []).filter((c) => !c.passed);
  const approved = output.status === "approved";
  const rejected = output.status === "rejected";

  return (
    <div className="card card-pad" style={{ boxShadow: "none" }}>
      <div className="row-between mb-1">
        <div className="row">
          <span className="strong small">{CHANNEL_LABELS[output.channel]}</span>
          {approved && <span className="pill pill-ok tiny">Approved</span>}
          {rejected && <span className="pill pill-danger tiny">Rejected</span>}
          {output.status === "format_failed" && (
            <span className="pill pill-warn tiny">Format check failed</span>
          )}
        </div>
        <span className="tiny dim">
          {output.char_count} chars
          {output.channel === "x" && " (weighted)"}
        </span>
      </div>

      {output.subject && (
        <div className="small mb-1">
          <span className="dim">Subject: </span>
          <span className="strong">{output.subject}</span>
        </div>
      )}

      <div className="preview small mb-1">{output.body}</div>

      {output.hashtags.length > 0 && (
        <div className="tiny muted mb-1">{output.hashtags.join(" ")}</div>
      )}

      {/* Every failed check names the ACTUAL measured value, so approving
          anyway is a knowing decision (§12.1). */}
      {failures.length > 0 && (
        <div className="alert alert-warn small mb-1">
          <strong>Format problems:</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {failures.map((check, i) => (
              <li key={i}>{check.detail}</li>
            ))}
          </ul>
        </div>
      )}

      {isHandoff && (
        // §2.9: a handoff channel can never reach `published`, and the
        // distinction is preserved everywhere it is displayed.
        <div className="tiny muted mb-1">
          This is generated and scheduled here, then sent to whoever posts it. It shows as
          awaiting posting — never as published — until they confirm with a URL.
        </div>
      )}

      {!readOnly && !approved && !rejected && (
        <>
          {showReject ? (
            <div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Why is this being rejected?"
              />
              <div className="row mt-1">
                <button
                  className="btn btn-sm btn-danger"
                  disabled={pending || !note.trim()}
                  onClick={() => onReject(output.id, note)}
                >
                  Reject this channel
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setShowReject(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {output.status === "format_failed" && (
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Approving despite the format problems — why?"
                />
              )}

              <div className="row">
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  style={{ width: "auto", flex: 1 }}
                  aria-label="When to publish"
                />
                <button
                  className="btn btn-sm btn-primary"
                  disabled={
                    pending ||
                    !canApprove ||
                    (output.status === "format_failed" && !note.trim())
                  }
                  title={
                    canApprove
                      ? undefined
                      : "Only a reviewer or an admin can approve content for publishing."
                  }
                  onClick={() =>
                    onApprove(
                      output.id,
                      when ? new Date(when).toISOString() : null,
                      note || undefined,
                    )
                  }
                >
                  Approve
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => setShowReject(true)}
                  disabled={pending}
                >
                  Reject
                </button>
              </div>

              {!when && (
                <div className="tiny dim">
                  {request.publish_target
                    ? `Leave blank to use the request's target: ${formatWhen(request.publish_target)}`
                    : request.hold_in_queue
                      ? "Leave blank to hold in the queue without a send time."
                      : "Leave blank to send as soon as it is approved."}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Images ─────────────────────────────────────────────────────────────────

function ImagePanel({
  images,
  pending,
  readOnly,
  onChoose,
}: {
  images: ImageCandidate[];
  pending: boolean;
  readOnly: boolean;
  onChoose: (imageId: string | null) => void;
}) {
  if (images.length === 0) {
    return (
      <p className="small muted">
        No openly licensed images were found for this article. That is fine — an image is
        optional, and one with no licence on record is never attached.
      </p>
    );
  }

  return (
    <div className="stack">
      <p className="tiny muted mb-0">
        Openly licensed, selected not generated. The licence and attribution travel with the
        image into the article and the LinkedIn post.
      </p>

      {images.map((image) => (
        <div
          key={image.id}
          className="card card-pad"
          style={{
            boxShadow: "none",
            borderColor: image.chosen ? "var(--accent)" : "var(--border)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.download_url}
            alt={image.alt_text ?? ""}
            style={{
              width: "100%",
              height: 120,
              objectFit: "cover",
              borderRadius: 6,
              marginBottom: 8,
              background: "var(--surface-2)",
            }}
          />
          <div className="tiny muted">{image.attribution_text}</div>
          <div className="tiny dim mt-1">
            {image.licence}
            {image.licence_url && (
              <>
                {" · "}
                <a href={image.licence_url} target="_blank" rel="noopener noreferrer">
                  licence
                </a>
              </>
            )}
          </div>
          {!readOnly && (
            <button
              className="btn btn-sm mt-1"
              disabled={pending}
              onClick={() => onChoose(image.chosen ? null : image.id)}
            >
              {image.chosen ? "Remove" : "Use this one"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Sources ────────────────────────────────────────────────────────────────

function SourcePanel({ sources }: { sources: Source[] }) {
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
              {source.excluded_reason && <span className="dim"> — {source.excluded_reason}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── Version history (§5.7) ─────────────────────────────────────────────────

function VersionPanel({
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildExcerptLookup(sources: Source[]) {
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

export type { Angle };
