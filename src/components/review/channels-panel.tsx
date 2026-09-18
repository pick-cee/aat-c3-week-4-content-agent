"use client";

import { useState } from "react";
import { approveChannel, approveChannels, rejectChannel, requestChannelRevision } from "@/app/actions/approvals";
import { CHANNEL_LABELS, formatWhen } from "../status";
import { useAction } from "./use-action";
import { CopyButton } from "./copy-button";
import { PostDialog } from "../post-dialog";
import type { ChannelOutput } from "@/lib/db/types";

/**
 * The channel decisions: approve, approve all, reject.
 *
 * One responsibility. It calls the approval actions itself rather than taking
 * callbacks from a parent, and each card owns its own pending state — with a
 * single shared `pending`, approving LinkedIn put a spinner on every button on
 * the screen.
 *
 * It takes the two facts it needs from the request (`holdInQueue`,
 * `publishTarget`) rather than the request itself, so nothing here depends on
 * fields it never reads.
 */

export function ChannelsPanel({
  requestId,
  outputs,
  holdInQueue,
  publishTarget,
  canApprove,
  locked,
  canRevise = false,
}: {
  requestId: string;
  outputs: ChannelOutput[];
  /** Whether approving with no time parks it in the queue. One boolean, not
      the whole request: this panel has no other use for it. */
  holdInQueue: boolean;
  /** The request's default send time, or null. */
  publishTarget: string | null;
  canApprove: boolean;
  locked: boolean;
  canRevise?: boolean;
}) {
  const action = useAction();
  const { pending } = action;
  const readOnly = locked;
  if (outputs.length === 0) {
    return <p className="small muted">No channel versions were produced.</p>;
  }

  /**
   * The ordinary case is "this article is good, send it everywhere".
   *
   * Approving one channel at a time made that three separate decisions with
   * three separate scheduling choices. Channels are still approved
   * independently underneath — this just stops charging a reviewer three
   * clicks for the common answer.
   *
   * Only clean drafts are included: a channel that failed its format rules
   * needs a written note saying why it is going out anyway, which is a
   * deliberate per-channel decision and not something to sweep into a
   * bulk action.
   */
  const readyToApprove = outputs.filter((o) => o.status === "draft");

  return (
    <div className="stack">
      {action.error && <div className="alert alert-error small">{action.error}</div>}

      {canApprove && !readOnly && readyToApprove.length > 1 && (
        <div className="card card-pad row-between" style={{ background: "var(--surface-2)" }}>
          <div className="min-w-0">
            <div className="small strong">Approve all {readyToApprove.length} channels</div>
            <div className="tiny muted">
              {holdInQueue
                ? "They go to the queue without a send time, and wait there until you give them one."
                : "They are scheduled with this request's send time."}
            </div>
          </div>
          <button
            className="btn btn-primary btn-sm"
            disabled={pending}
            onClick={() =>
              action.run(() =>
                approveChannels(requestId, readyToApprove.map((o) => o.id), null),
              )
            }
          >
            {pending ? <span className="spin" /> : "Approve all"}
          </button>
        </div>
      )}

      {outputs.map((output) => (
        <ChannelCard
          key={output.id}
          requestId={requestId}
          output={output}
          holdInQueue={holdInQueue}
          publishTarget={publishTarget}
          canApprove={canApprove}
          readOnly={readOnly}
          canRevise={canRevise && canApprove}
        />
      ))}
    </div>
  );
}

/**
 * Exactly what goes on the platform.
 *
 * Hashtags render separately in the card but belong at the end of the post, and
 * a newsletter's subject line is part of what the sender needs. Copying only
 * the body would hand over something incomplete.
 */
function copyText(output: ChannelOutput): string {
  const parts: string[] = [];
  if (output.subject) parts.push(output.subject, "");
  parts.push(output.body);

  // Only append hashtags the body does not already carry.
  const missing = (output.hashtags ?? []).filter((tag) => !output.body.includes(tag));
  if (missing.length > 0) parts.push("", missing.join(" "));

  return parts.join("\n").trim();
}

function ChannelCard({
  requestId,
  output,
  holdInQueue,
  publishTarget,
  canApprove,
  readOnly,
  canRevise,
}: {
  requestId: string;
  output: ChannelOutput;
  holdInQueue: boolean;
  publishTarget: string | null;
  canApprove: boolean;
  readOnly: boolean;
  canRevise: boolean;
}) {
  // Its own action state: approving LinkedIn used to put a spinner on the
  // newsletter's button too, because `pending` came from the shared parent.
  const action = useAction();
  const pending = action.pending;
  const [showPost, setShowPost] = useState(false);
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [showRevision, setShowRevision] = useState(false);
  const [revisionNote, setRevisionNote] = useState("");

  const isHandoff = output.channel === "linkedin" || output.channel === "x";
  const failures = (output.format_check?.checks ?? []).filter((c) => !c.passed);
  const approved = output.status === "approved";
  const rejected = output.status === "rejected";

  return (
    <div className="card card-pad" style={{ boxShadow: "none" }}>
      {action.error && <div className="alert alert-error tiny">{action.error}</div>}
      <div className="row-between mb-1">
        <div className="row">
          <span className="strong small">{CHANNEL_LABELS[output.channel]}</span>
          {approved && <span className="pill pill-ok tiny">Approved</span>}
          {rejected && <span className="pill pill-danger tiny">Rejected</span>}
          {output.status === "format_failed" && (
            <span className="pill pill-warn tiny">Format check failed</span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="tiny dim">
            {output.char_count} chars
            {output.channel === "x" && " (weighted)"}
          </span>
          {/* The whole point of a handoff channel is taking this text to the
              platform, so both actions live here: read it in full, or copy it.
              It used to be a scrolling preview with no copy at all. */}
          <button className="btn btn-sm btn-ghost" onClick={() => setShowPost(true)}>
            View the post
          </button>
          <CopyButton
            text={copyText(output)}
            label={isHandoff ? `Copy for ${CHANNEL_LABELS[output.channel]}` : "Copy"}
            className="btn btn-sm btn-ghost"
          />
        </div>
      </div>

      {output.subject && (
        <div className="small mb-1">
          <span className="dim">Subject: </span>
          <span className="strong">{output.subject}</span>
        </div>
      )}

      {/* A readable extract; the whole thing is one click away. */}
      <div
        className="preview small mb-1"
        style={{ maxHeight: 160, overflow: "hidden", whiteSpace: "pre-wrap" }}
      >
        {output.body}
      </div>

      <PostDialog
        open={showPost}
        onClose={() => setShowPost(false)}
        channelLabel={CHANNEL_LABELS[output.channel]}
        subject={output.subject}
        body={output.body}
        hashtags={output.hashtags ?? []}
        charCount={output.char_count}
        weighted={output.channel === "x"}
      />

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
          awaiting posting, never as published, until they confirm with a URL.
        </div>
      )}

      {output.revision_note && <p className="tiny muted">Revision note: {output.revision_note}</p>}
      {canRevise && (
        <div className="mt-2">
          {showRevision ? <div className="stack" style={{ gap: 8 }}>
            <label htmlFor={`revise-${output.id}`}>What should change in {CHANNEL_LABELS[output.channel]}?</label>
            <textarea id={`revise-${output.id}`} rows={3} maxLength={2000} value={revisionNote}
              onChange={e => setRevisionNote(e.target.value)} disabled={pending}
              placeholder={output.channel === "newsletter" ? "Rewrite the opening to be more direct and add a friendly sign-off. Keep the other sections." : "Shorten the opening and make the call to action clearer. Keep the facts from the article."} />
            <p className="tiny muted mb-0">Uses the current article as its source. Only this channel gets a new version, and it needs fresh approval. Any pending send for this channel is withdrawn. Copies already sent stay unchanged.</p>
            <div className="btn-row">
              <button className="btn btn-primary btn-sm" disabled={pending || !revisionNote.trim()}
                onClick={() => action.run(async () => {
                  const result = await requestChannelRevision(requestId, output.id, revisionNote);
                  if (result.ok) { setShowRevision(false); setRevisionNote(""); }
                  return result;
                })}>{pending ? "Requesting revision..." : "Revise this channel"}</button>
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => setShowRevision(false)}>Cancel</button>
            </div>
          </div> : <button className="btn btn-sm" disabled={pending} onClick={() => setShowRevision(true)}>Revise {CHANNEL_LABELS[output.channel]}</button>}
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
              <div className="btn-row mt-1">
                <button
                  className="btn btn-sm btn-danger"
                  disabled={pending || !note.trim()}
                  onClick={() => action.run(() => rejectChannel(requestId, output.id, note))}
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
                  placeholder="Approving despite the format problems, why?"
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
                    action.run(() =>
                      approveChannel(
                        requestId,
                        output.id,
                        when ? new Date(when).toISOString() : null,
                        note || undefined,
                      ),
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
                  {publishTarget
                    ? `Leave blank to use the request's target: ${formatWhen(publishTarget)}`
                    : holdInQueue
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
