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

  const { data: requestRow } = await db
    .from(table("content_requests"))
    .select("*")
    .eq("id", id)
    .maybeSingle();

  const request = requestRow as unknown as ContentRequest | null;
  if (!request) notFound();

  const [sources, angles, versions, outputs, images, activity] = await Promise.all([
    db
      .from(table("sources"))
      .select("*")
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

  const versionList = (versions.data ?? []) as unknown as ArticleVersion[];
  const latest = versionList[0] ?? null;

  const { data: evaluationRows } = latest
    ? await db
        .from(table("evaluations"))
        .select("*")
        .eq("request_id", id)
        .order("created_at", { ascending: false })
    : { data: [] };

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
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <RequestStatusPill status={request.status} />
            {request.slug &&
              ["content_review", "scheduled", "publishing", "published"].includes(
                request.status,
              ) && (
                <Link href={`/a/${request.slug}`} className="tiny" target="_blank">
                  View the public article ↗
                </Link>
              )}
          </div>
          <h1 style={{ fontSize: 21 }}>{request.idea}</h1>
          <p>
            For {request.target_audience} · Created {formatWhen(request.created_at)} ·{" "}
            <Cost
              cents={request.actual_cost_cents}
              complete={request.cost_complete}
              budget={request.budget_cents}
            />
          </p>
        </div>

        <DeleteRequest requestId={request.id} />
      </div>

      <div className="card card-pad mb-3">
        <Stepper request={request} />
      </div>

      {isRunning && <RunnerPoll requestId={request.id} status={request.status} />}

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

      {["content_review", "scheduled", "publishing", "published"].includes(request.status) &&
        latest && (
          <GateTwo
            request={request}
            version={latest}
            versions={versionList}
            evaluations={evaluations}
            outputs={(outputs.data ?? []) as unknown as ChannelOutput[]}
            images={(images.data ?? []) as unknown as ImageCandidate[]}
            sources={(sources.data ?? []) as unknown as Source[]}
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

      <ActivityFeed entries={(activity.data ?? []) as unknown as ActivityLogEntry[]} />
    </>
  );
}
