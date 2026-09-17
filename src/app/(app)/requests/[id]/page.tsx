import { ArticleView } from "@/components/article-view";
import { ArticleExport } from "@/components/article-export";
import { buildExcerptLookup } from "@/components/review/excerpt-lookup";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { currentProfile, serviceClient, canApprove, table } from "@/lib/db/client";
import { RequestStatusPill, Cost, formatWhen } from "@/components/status";
import { Stepper } from "@/components/stepper";
import { RunnerPoll } from "@/components/runner-poll";
import { GateOne } from "@/components/gate-one";
import { GateTwo } from "@/components/gate-two";
import { FailurePanel } from "@/components/failure-panel";
import { ActivityFeed } from "@/components/activity-feed";
import { DeleteRequest } from "@/components/delete-request";
import type {
  ActivityLogEntry,
  Angle,
  ArticleVersion,
  ChannelOutput,
  ContentRequest,
  Evaluation,
  ImageCandidate,
  Source,
} from "@/lib/db/types";

/**
 * Request detail. DESIGN.md §16.
 *
 * "The pipeline as a horizontal stepper with the current step lit, the cost so
 * far against the budget, and the step-appropriate workspace below."
 */

export const dynamic = "force-dynamic";

export default async function RequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const profile = await currentProfile();
  if (!profile) redirect("/");

  const db = serviceClient();

  const { data: requestRow, error: requestError } = await db
    .from(table("content_requests"))
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  const request = requestRow as unknown as ContentRequest | null;
  if (requestError) throw new Error("Could not load this request. Please refresh.");
  if (!request) notFound();

  const [sources, angles, versions, outputs, images, activity] = await Promise.all([
    db
      .from(table("sources"))
      .select("id, request_id, title, url, site_name, author, published_at, included, excluded_reason, relevance_score, fetch_status, fetch_error, origin, embed_failed, embed_retryable, markdown_chars, from_cache")
      .eq("request_id", id)
      .order("relevance_score", { ascending: false, nullsFirst: false }),
    db.from(table("angles")).select("*").eq("request_id", id).order("created_at"),
    db.from(table("article_versions")).select("*").eq("request_id", id).order("version", { ascending: false }),
    db.from(table("channel_outputs")).select("*").eq("request_id", id).order("created_at"),
    db.from(table("images")).select("*").eq("request_id", id).order("created_at"),
    db
      .from(table("activity_log"))
      .select("*")
      .eq("request_id", id)
      .order("created_at", { ascending: false })
      .limit(40),
  ]);

  const loadError = [sources, angles, versions, outputs, images, activity].find(result => result.error)?.error;
  if (loadError) throw new Error("Could not load the saved workspace. Please refresh.");

  const versionList = (versions.data ?? []) as unknown as ArticleVersion[];
  const latest = versionList[0] ?? null;

  const { data: excerptRows, error: excerptError } = latest?.excerpt_ids_used?.length
    ? await db.from(table("excerpts")).select("id, source_id, text").in("id", latest.excerpt_ids_used)
    : { data: [], error: null };
  if (excerptError) throw new Error("Could not load the supporting excerpts. Please refresh.");
  const reviewExcerpts = excerptRows ?? [];
  const reviewSources = (sources.data ?? []) as unknown as Source[];
  const { data: evaluationRows, error: evaluationError } = latest
    ? await db
        .from(table("evaluations"))
        .select("*")
        .eq("request_id", id)
        .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (evaluationError) throw new Error("Could not load the article checks. Please refresh.");

  const evaluations = (evaluationRows ?? []) as unknown as Evaluation[];

  // The runner is driven by the client polling while a user is watching
  // (§3.1). Only in-flight states need it.
  const isRunning = [
    "researching",
    "drafting",
    "evaluating",
    "revising",
    "adapting",
  ].includes(request.status);

  return (
    <>
      <Link href="/" className="small muted" style={{ display: "inline-block", marginBottom: 20 }}>Back to content library</Link>
      <div className="request-heading">
        <div><RequestStatusPill status={request.status} /><h1>{latest?.title ?? request.idea}</h1><div className="request-meta"><span>For {request.target_audience}</span>{latest && <span>{latest.word_count?.toLocaleString() ?? "0"} words / Version {latest.version}</span>}{request.slug && ["scheduled", "publishing", "published"].includes(request.status) && <Link href={"/a/" + request.slug} target="_blank">Open public article</Link>}</div></div>
        <div className="request-budget"><span>SPEND / LIMIT</span><Cost cents={request.actual_cost_cents} complete={request.cost_complete} budget={request.budget_cents} />{Number(request.reserved_cost_cents) > 0 && <small className="muted" style={{ display: "block", marginTop: 5 }}>${(Number(request.reserved_cost_cents) / 100).toFixed(2)} reserved for unconfirmed usage</small>}<progress max={request.budget_cents} value={request.actual_cost_cents} aria-label="Request budget used" /></div>
      </div>
      <Stepper request={request} />
      {latest && <div className="row mb-2" style={{ justifyContent: "flex-end" }}><ArticleExport title={latest.title} body={latest.body_md} sources={((sources.data ?? []) as unknown as Source[]).filter(source=>source.included)} /></div>}
      {isRunning && <RunnerPoll requestId={request.id} status={request.status} step={request.current_step} startedAt={request.step_started_at} />}
      {latest && (isRunning || ["failed", "budget_exceeded"].includes(request.status)) && <section className="card mb-3"><div className="card-head"><h2>Your article</h2><span className="pill pill-info">Draft awaiting approval</span></div><div className="card-pad"><ArticleView bodyMd={latest.body_md} claimMap={latest.claim_map} excerpts={buildExcerptLookup(reviewSources, reviewExcerpts)} sources={reviewSources} /></div></section>}

      {["failed", "budget_exceeded", "needs_human"].includes(request.status) && (
        <FailurePanel request={request} canApprove={canApprove(profile)} />
      )}

      {request.status === "plan_review" && (
        <GateOne
          request={request}
          sources={(sources.data ?? []) as unknown as Source[]}
          angles={(angles.data ?? []) as unknown as Angle[]}
        />
      )}

      {/* `needs_human` after two revisions means a finished draft is waiting on
          a judgement call, so the reviewer must be able to READ it. Without
          this the screen offered "Cancel this request" and nothing else. */}
      {["content_review", "scheduled", "publishing", "published", "needs_human"].includes(
        request.status,
      ) &&
        latest && (
          <GateTwo
            request={request}
            version={latest}
            versions={versionList}
            evaluations={evaluations}
            outputs={(outputs.data ?? []) as unknown as ChannelOutput[]}
            images={(images.data ?? []) as unknown as ImageCandidate[]}
            sources={(sources.data ?? []) as unknown as Source[]}
            excerpts={reviewExcerpts}
            canApprove={canApprove(profile)}
          />
        )}

      {/* While research is still running there is nothing to review, but the
          sources read so far are worth seeing. */}
      {request.status === "researching" && (
        <div className="card mb-3">
          <div className="card-head">
            <h2 style={{ fontSize: 15 }}>Sources so far</h2>
            <span className="tiny dim">
              {(sources.data ?? []).length} found
            </span>
          </div>
          <div className="card-pad">
            {(sources.data ?? []).length === 0 ? (
              <p className="small muted mb-0">Looking for material…</p>
            ) : (
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {(sources.data ?? []).slice(0, 10).map((source) => (
                  <li key={source.id as string}>
                    {(source.title as string) ?? (source.url as string)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <details className="activity-details"><summary>Activity & request details</summary><p className="small muted">Original brief: {request.idea}</p><ActivityFeed entries={(activity.data ?? []) as unknown as ActivityLogEntry[]} /><div className="mt-2"><DeleteRequest requestId={request.id} /></div></details>
    </>
  );
}
