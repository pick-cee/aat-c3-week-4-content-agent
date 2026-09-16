import { redirect } from "next/navigation";
import Link from "next/link";
import { currentProfile, serviceClient, canApprove, table } from "@/lib/db/client";
import { RequestStatusPill, Cost, formatWhen } from "@/components/status";
import { RecycleBinActions } from "@/components/recycle-bin-actions";
import type { ContentRequest } from "@/lib/db/types";

/**
 * Deleted requests, kept rather than destroyed.
 *
 * A hard delete cascaded to `model_calls`, so clearing out a few drafts made
 * "Spent this month" read $0 for money that had genuinely been spent. Deleting
 * now hides the row and keeps the cost, and this is where the hidden rows live
 * so nothing is lost without someone choosing to lose it.
 */

export const dynamic = "force-dynamic";

export default async function RecycleBinPage() {
  const profile = await currentProfile();
  if (!profile) redirect("/");

  const { data } = await serviceClient()
    .from(table("content_requests"))
    .select("*")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })
    .limit(100);

  const requests = (data ?? []) as unknown as ContentRequest[];
  const total = requests.reduce((sum, r) => sum + (r.actual_cost_cents ?? 0), 0);

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Recycle bin</h1>
          <p className="muted mb-0">
            Deleted requests are kept here. What they cost still counts towards this
            month&rsquo;s spend, because the money was spent.
          </p>
        </div>
        <Link href="/" className="btn btn-ghost btn-sm">
          Back to dashboard
        </Link>
      </header>

      {requests.length === 0 ? (
        <div className="card card-pad empty">
          <p className="mb-0 muted">Nothing has been deleted.</p>
        </div>
      ) : (
        <>
          <div className="card card-pad mb-3">
            <span className="small muted">
              {requests.length} deleted request{requests.length === 1 ? "" : "s"}, together
              costing <Cost cents={total} />. Restoring one puts it back on the dashboard
              exactly where it left off.
            </span>
          </div>

          <div className="stack">
            {requests.map((request) => (
              <article key={request.id} className="card card-pad row-between">
                <div className="min-w-0">
                  <div className="row" style={{ gap: 8 }}>
                    <RequestStatusPill status={request.status} />
                    <span className="tiny muted">
                      Deleted {formatWhen(request.deleted_at)}
                    </span>
                  </div>
                  <p className="mb-0 mt-1 truncate-2">{request.idea}</p>
                  <span className="tiny muted">
                    Cost <Cost cents={request.actual_cost_cents} complete={request.cost_complete} />
                  </span>
                </div>

                <RecycleBinActions
                  requestId={request.id}
                  canPurge={canApprove(profile)}
                />
              </article>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
