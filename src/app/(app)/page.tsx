import Link from "next/link";
import { currentProfile, serviceClient, table } from "@/lib/db/client";
import { RequestStatusPill, ChannelChip, Cost, Ago } from "@/components/status";
import { Landing } from "@/components/landing";
import { Icon } from "@/components/icon";
import { AutoRefresh } from "@/components/auto-refresh";
import { DeleteRequest } from "@/components/delete-request";
import { UncertainDeliveries } from "@/components/uncertain-deliveries";
import { loadTiles, loadChannelStates } from "@/lib/dashboard";
import type { ContentRequest, RequestStatus } from "@/lib/db/types";

export const dynamic = "force-dynamic";
const FILTERS: { key: string; label: string; statuses: RequestStatus[] }[] = [
  { key: "all", label: "All content", statuses: [] },
  { key: "review", label: "Needs review", statuses: ["plan_review", "content_review", "needs_human"] },
  { key: "working", label: "In progress", statuses: ["researching", "drafting", "evaluating", "revising", "adapting", "publishing"] },
  { key: "scheduled", label: "Scheduled", statuses: ["scheduled"] },
  { key: "published", label: "Published", statuses: ["published"] },
  { key: "attention", label: "Needs attention", statuses: ["failed", "budget_exceeded", "needs_human"] },
];

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ error?: string; filter?: string; q?: string; page?: string }> }) {
  const params = await searchParams;
  const profile = await currentProfile().catch(() => null);
  if (!profile) return <Landing error={params.error} />;
  const filter = FILTERS.find(f => f.key === params.filter) ?? FILTERS[0]!;
  const q = (params.q ?? "").trim().slice(0, 160);
  const page = Math.max(1, Math.min(10000, Number.parseInt(params.page ?? "1", 10) || 1));
  let query = serviceClient().from(table("content_requests")).select("*", { count: "exact" }).is("deleted_at", null).neq("status", "cancelled").order("updated_at", { ascending: false });
  if (filter.statuses.length) query = query.in("status", filter.statuses);
  if (q) query = query.ilike("idea", `%${q.replace(/[\\%_]/g, " ")}%`);
  const [tiles, result] = await Promise.all([loadTiles(), query.range((page - 1) * 20, page * 20 - 1)]);
  const requests = (result.data ?? []) as unknown as ContentRequest[];
  const channelStates = await loadChannelStates(requests.map(r => r.id));
  const active = requests.some(r => FILTERS[2]!.statuses.includes(r.status));
  const total = result.count ?? 0;
  const href = (key: string, p = 1) => `/?${new URLSearchParams({ filter: key, ...(q ? { q } : {}), ...(p > 1 ? { page: String(p) } : {}) })}`;
  return <>
    <AutoRefresh active={active} />
    <div className="workspace-eyebrow">YOUR WORKSPACE <span> / </span> CONTENT LIBRARY</div>
    <div className="page-head library-heading"><div><h1>Make room for good content.</h1><p>From the first idea to the final approval. Everything your team is creating.</p></div><Link href="/requests/new" className="btn btn-primary"><Icon name="plus" size={18} />Create content</Link></div>
    <div className="metrics-grid">
      <Link href="/?filter=review" className="metric-card metric-featured"><div className="metric-label">Ready for your review <Icon name="arrow" size={17} /></div><strong>{tiles.needsYou ?? "—"}</strong><span>Choose an angle or approve content</span></Link>
      <Link href="/queue" className="metric-card"><div className="metric-label">Scheduled today <Icon name="calendar" size={17} /></div><strong>{tiles.scheduledToday ?? "—"}</strong><span>Approved and lined up to go</span></Link>
      <Link href="/?filter=attention" className="metric-card"><div className="metric-label">Needs attention <Icon name="clock" size={17} /></div><strong className={tiles.failedBlocked ? "text-danger" : ""}>{tiles.failedBlocked ?? "—"}</strong><span>Requests that need a hand</span></Link>
      <div className="metric-card"><div className="metric-label">AI spend this month <span>USD</span></div><strong><Cost cents={tiles.spentCents} complete={tiles.spendComplete} /></strong><span>Usage recorded across your workspace</span></div>
    </div>
    <UncertainDeliveries />
    <section className="library-section" aria-label="Content library">
      <div className="library-toolbar"><div><h2>Content library <span className="count-badge">{result.error ? "—" : total}</span></h2><p className="small muted">{q ? `Results for “${q}”` : "Your ideas, drafts, and published work."}</p></div><form className="search-field" role="search"><Icon name="search" size={17} /><input aria-label="Search content briefs" name="q" defaultValue={q} placeholder="Search content briefs…" /><input type="hidden" name="filter" value={filter.key} /><button className="sr-only" type="submit">Search</button></form></div>
      <nav className="library-filters" aria-label="Filter content">{FILTERS.map(f => <Link key={f.key} href={href(f.key)} aria-current={f.key === filter.key ? "page" : undefined}>{f.label}</Link>)}</nav>
      {result.error ? <div className="empty"><h3>We couldn’t load your content</h3><p>Your work is still saved. Refresh to try again.</p><Link href={href(filter.key)} className="btn">Try again</Link></div> : requests.length === 0 ? <div className="empty library-empty"><span className="empty-icon"><Icon name="file" size={28} /></span><h3>{q || filter.key !== "all" ? "No content matches this view" : "Your next great piece starts here"}</h3><p>{q || filter.key !== "all" ? "Try another search or view all your content." : "Bring an idea and your audience. We’ll help you turn it into a sourced article and posts for your channels."}</p><Link href={q || filter.key !== "all" ? "/" : "/requests/new"} className="btn btn-primary">{q || filter.key !== "all" ? "View all content" : "Create your first piece"}<Icon name="arrow" size={16} /></Link></div> : <>
        <div className="library-table-head"><span>CONTENT</span><span>STATUS</span><span>CHANNELS</span><span>SPEND</span><span>ACTIONS</span></div>
        <div className="library-rows">{requests.map(r => <div className="content-row" key={r.id}>
          <div className="content-row-main"><span className="document-icon"><Icon name="file" /></span><div><h3><Link href={`/requests/${r.id}`} className="content-row-link">{r.idea}</Link></h3><div className="content-row-meta"><span>{r.target_audience}</span><span>·</span><Ago iso={r.updated_at} /></div></div></div>
          <div className="content-row-status"><RequestStatusPill status={r.status} /><small>{r.status === "plan_review" ? "Choose an angle" : r.status === "content_review" ? "Review & approve" : r.failure_reason ? "Open for details" : ""}</small></div>
          <div className="row content-row-channels">{r.channels.map(c => { const state = channelStates.get(r.id)?.find(s=>s.channel===c); return <ChannelChip key={c} channel={c} tone={state?.tone} />; })}</div>
          <div className="content-row-cost"><Cost cents={r.actual_cost_cents} complete={r.cost_complete} /><small>of ${(r.budget_cents / 100).toFixed(2)}</small></div>
          <div className="content-row-actions"><DeleteRequest requestId={r.id} requestTitle={r.idea} compact returnToLibrary={false} /></div>
        </div>)}</div>
        <div className="library-footer"><span>Showing {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} of {total} pieces</span><div className="row">{page > 1 && <Link className="btn btn-sm" href={href(filter.key, page - 1)}>Previous</Link>}{page * 20 < total && <Link className="btn btn-sm" href={href(filter.key, page + 1)}>Next</Link>}</div></div>
      </>}
    </section>
    <div className="workspace-footer"><span><span className="workspace-dot" /> Human approval at every publishing decision</span><Link href="/settings">Manage your brand voice <Icon name="arrow" size={14} /></Link></div>
  </>;
}
