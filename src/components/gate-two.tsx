"use client";

import { useState } from "react";
import { requestRevision, saveHumanEdit } from "@/app/actions/approvals";
import { ArticleView } from "./article-view";
import { EvaluationReport } from "./evaluation-report";
import { ChannelsPanel } from "./review/channels-panel";
import { ImagePanel } from "./review/image-panel";
import { SourcesPanel } from "./review/sources-panel";
import { VersionsPanel } from "./review/versions-panel";
import { NextAction } from "./review/next-action";
import { TabButton, type Tab } from "./review/tab-button";
import { buildExcerptLookup, type ReviewExcerpt } from "./review/excerpt-lookup";
import { useAction } from "./review/use-action";
import { isArticleLocked, areChannelsLocked } from "@/lib/pipeline/review-locks";
import type {
  ArticleVersion,
  ChannelOutput,
  ContentRequest,
  Evaluation,
  ImageCandidate,
  Source,
} from "@/lib/db/types";

/**
 * Gate two: content review. DESIGN.md §14.2.
 *
 * This file COMPOSES the review screen and owns nothing else. Each panel is a
 * separate module that calls its own server actions and holds its own pending
 * and error state:
 *
 *   review/channels-panel  approve, approve all, reject
 *   review/image-panel     choose an image
 *   review/sources-panel   what it was written from
 *   review/versions-panel  the draft history
 *   review/next-action     what still needs a person
 *
 * It was previously 858 lines holding all of them, threading `pending`,
 * `canApprove` and a callback per action down through every panel — so the
 * parent owned state only the children used, and approving one channel put a
 * spinner on every button on the screen.
 *
 * What stays here is genuinely shared: which tab is open, and the article
 * itself, because editing the article is the one action that invalidates
 * everything else on the page.
 */

export function GateTwo({
  request,
  version,
  versions,
  evaluations,
  outputs,
  images,
  sources,
  excerpts,
  canApprove,
}: {
  request: ContentRequest;
  version: ArticleVersion;
  versions: ArticleVersion[];
  evaluations: Evaluation[];
  outputs: ChannelOutput[];
  images: ImageCandidate[];
  sources: Source[];
  excerpts: ReviewExcerpt[];
  canApprove: boolean;
}) {
  /**
   * Channels first, not the evaluation report.
   *
   * A reviewer opens this screen to decide whether the content goes out. The
   * evaluation is how they check that decision, not the decision itself — and
   * opening on a wall of rubric scores and flagged claims buries the one thing
   * they came to do. The report is one click away and badged when it has
   * something to say.
   */
  /**
   * Opens on the work, or on the draft once there is none.
   *
   * Channels while a decision is outstanding; the draft when everything is
   * decided, because then the article is the only thing left to look at.
   */
  const anythingUndecided = outputs.filter(o => o.article_version_id === version.id).some(
    (o) => o.status === "draft" || o.status === "format_failed",
  );
  const [tab, setTab] = useState<Tab>(anythingUndecided ? "channels" : "draft");
  // Only the article's own actions live here now.
  const article = useAction();
  const pending = article.pending;
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(version.body_md);
  const [revisionNote, setRevisionNote] = useState("");
  const [showRevision, setShowRevision] = useState(false);

  const evaluation = evaluations.find((e) => e.article_version_id === version.id) ?? null;

  // The latest output per channel: re-adaptation creates a new version rather
  // than overwriting.
  const latestOutputs = Object.values(
    outputs.filter(o => o.article_version_id === version.id).reduce<Record<string, ChannelOutput>>((acc, output) => {
      const existing = acc[output.channel];
      if (!existing || output.version > existing.version) acc[output.channel] = output;
      return acc;
    }, {}),
  );

  const excerptLookup = buildExcerptLookup(sources, excerpts);

  /**
   * Whether the ARTICLE is closed for editing.
   *
   * Approving one channel calls `moveToScheduled`, which takes the request
   * from `content_review` to `scheduled`. Deriving read-only from that meant
   * approving LinkedIn locked the whole screen — the newsletter was still a
   * `draft` and perfectly approvable, but there was no longer a button. One
   * approval silently ended the review.
   *
   * Editing the article after something has been approved is genuinely closed,
   * because the approved channel versions were derived from it. Deciding the
   * REMAINING channels is not, and that is a separate question answered per
   * channel below.
   */
  const articleLocked = isArticleLocked(request.status);
  const channelsLocked = areChannelsLocked(request.status);

  return (
    <>
      {article.error && <div className="alert alert-error">{article.error}</div>}

      {/* What needs a decision, before anything else on the screen.
          A reviewer should not have to read two panes and count pills to work
          out whether they are finished. */}
      <NextAction
        outputs={latestOutputs}
        channelsLocked={channelsLocked}
        articleLocked={articleLocked}
        status={request.status}
        onOpenChannels={() => setTab("channels")}
      />

      {channelsLocked && (
        <div className="alert alert-info">
          This request is {request.status.replace("_", " ")}. The content below is what was
          approved.
        </div>
      )}

        {/* One thing on screen at a time.
            The draft and the decisions were two jobs sharing one scroll, so a
            reviewer passed 1,243 words to reach the approve button. They are
            tabs now: read the draft, or make the decision, not both at once. */}
        <section className="section">
          <div className="card">
          {/* Ordered by use: the decision, then the thing it is about, then
              reference. Channels was the default while sitting third in the
              bar, which reads as an afterthought. */}
          <div className="tabs">
            <TabButton
              id="channels"
              tab={tab}
              setTab={setTab}
              label="Channels"
              badge={latestOutputs.length}
            />
            <TabButton id="draft" tab={tab} setTab={setTab} label="Draft" />
            <TabButton id="evaluation" tab={tab} setTab={setTab} label="Evaluation" />
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

          {/* No inner scrollbar. The panel is full width now, so it can be
              as tall as its content and the page scrolls once, two nested
              scroll areas is what made the old right column feel like a
              letterbox. */}
          <div className="card-pad">
            {tab === "draft" && (
              <>
                <div className="row-between mb-2">
                  <span className="tiny dim">
                    Version {version.version} · {version.origin.replace("_", " ")} ·{" "}
                    {version.word_count} words
                  </span>
                  {!articleLocked && (
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
                  citation marker will be flagged, you can accept it, but you will see it.
                </div>
                <div className="row">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={pending}
                    onClick={() =>
                      article.run(async () => {
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
              </>
            )}

            {tab === "evaluation" && <EvaluationReport evaluation={evaluation} />}

            {tab === "channels" && (
              <ChannelsPanel
                requestId={request.id}
                outputs={latestOutputs}
                holdInQueue={request.hold_in_queue}
                publishTarget={request.publish_target}
                canApprove={canApprove}
                locked={channelsLocked}
              />
            )}

            {tab === "image" && (
              <ImagePanel requestId={request.id} images={images} locked={articleLocked} />
            )}

            {tab === "sources" && <SourcesPanel sources={sources} />}

            {tab === "versions" && (
              <VersionsPanel versions={versions} evaluations={evaluations} />
            )}
          </div>

          {!articleLocked && (
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
                  <div className="btn-row mt-1">
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={pending || !revisionNote.trim()}
                      onClick={() => article.run(() => requestRevision(request.id, revisionNote))}
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
                  className="btn btn-sm btn-block"
                  onClick={() => setShowRevision(true)}
                >
                  Request a revision
                </button>
              )}
            </div>
          )}
          </div>
        </section>

    </>
  );
}

/**
 * One line naming the outstanding decision, and a way to get to it.
 *
 * The screen previously opened with a stepper, a status banner and two dense
 * scrolling panes, and said nothing about what the person was there to do. A
 * founder had to read both panes and count status pills to notice that the
 * newsletter still needed approving.
 *
 * Status, ownership and what-needs-me first (§16). This is that.
 */
