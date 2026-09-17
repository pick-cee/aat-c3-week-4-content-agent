/** Live test-pack engine runs. Uses .env, real research/model providers, no publishing.
 * Notification email is disabled only in this maintenance process. Fixtures remain
 * available for review; the JSON report records all timing and provider receipts.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { serviceClient, table } from "../src/lib/db/client";
import { runStep } from "../src/lib/pipeline/runner";
import { DEMO_ACCOUNT } from "../src/lib/personas";
import { countXCharacters, countWords } from "../src/lib/text";

process.env.RESEND_API_KEY = "";
const cases: Record<string, { idea: string; audience: string; keyword?: string; urls: string[]; stopAtPlan?: boolean }> = {
  row1: { idea: "Why our time-to-hire keeps slipping and what actually shortens it", audience: "Heads of Talent at 50–200 person startups", urls: [] },
  row2: { idea: "Structured interviews: what the evidence actually supports", audience: "Hiring managers who run their own interview loops", keyword: "structured interviews", urls: ["https://www.pin.com/blog/structured-interviews-guide/", "https://www.criteriacorp.com/blog/reduce-hiring-bias-with-structured-interviews", "https://www.jobscore.com/articles/interviewing-best-practices/"] },
  row4: { idea: "What a good candidate scorecard contains", audience: "First-time interviewers", urls: ["https://www.criteriacorp.com/blog/reduce-hiring-bias-with-structured-interviews"] },
  row8: { idea: "Remote hiring pitfalls", audience: "Founders hiring their first ten people", urls: ["https://example.com/definitely-not-a-real-page-404", "https://www.ft.com/content/does-not-matter-which", "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", "https://example.com", "https://handbook.gitlab.com/handbook/company/culture/all-remote/hiring/", "https://www.jobscore.com/articles/interviewing-best-practices/"], stopAtPlan: true },
  niche: { idea: "Procurement rituals of 14th century Genoese wool guilds", audience: "Founders researching unusual procurement practices", urls: [], stopAtPlan: true },
};
async function main() {
  const name = process.argv[2] ?? "row8", spec = cases[name];
  if (!spec) throw new Error("Unknown test case");
  const db = serviceClient();
  const profile = await db.from(table("profiles")).select("id").eq("email", DEMO_ACCOUNT.email).single();
  if (profile.error) throw new Error(profile.error.message);
  const started = Date.now(), id = randomUUID();
  const report: any = { case: name, requestId: id, input: spec, startedAt: new Date(started).toISOString(), mode: "engine harness; real providers; automatic test angle selection; no publishing", events: [] };
  mkdirSync("tmp/w4-tests", { recursive: true });
  const save = () => writeFileSync(`tmp/w4-tests/${name}-${id}.json`, JSON.stringify(report, null, 2));
  const inserted = await db.from(table("content_requests")).insert({ id, created_by: profile.data.id, idea: spec.idea, target_audience: spec.audience, primary_keyword: spec.keyword ?? null, seed_urls: spec.urls, channels: ["linkedin", "x", "newsletter"], budget_cents: 150, status: "researching", current_step: "discover", submit_token: `w4-${id}`, hold_in_queue: true });
  if (inserted.error) throw new Error(inserted.error.message);
  save(); console.log(JSON.stringify({ case: name, id, startedAt: report.startedAt }));
  try {
    for (let iteration = 0; iteration < 80 && Date.now() - started < 12 * 60_000; iteration++) {
      const at = Date.now(), result = await runStep(id);
      const event = { elapsedMs: Date.now() - started, durationMs: Date.now() - at, ...result };
      report.events.push(event); save(); console.log(JSON.stringify(event));
      const versions = await db.from(table("article_versions")).select("id,created_at,version").eq("request_id", id).order("version").limit(1);
      if (versions.error) throw new Error(versions.error.message);
      if (versions.data?.length && !report.firstDraftMs) { report.firstDraftMs = Date.parse(versions.data[0]!.created_at) - started; report.firstDraftObservedMs = Date.now() - started; save(); }
      if (result.to === "plan_review") {
        report.researchReadyMs ??= Date.now() - started;
        const angles = await db.from(table("angles")).select("*").eq("request_id", id).order("created_at");
        if (angles.error) throw new Error(angles.error.message);
        report.angles = angles.data;
        if (spec.stopAtPlan) break;
        report.angleChosenMs = Date.now() - started;
        const chosen = await db.rpc("choose_content_angle", { p_request_id: id, p_angle_id: angles.data[0]!.id });
        if (chosen.error || !chosen.data) throw new Error(chosen.error?.message ?? "Angle selection refused");
        save(); continue;
      }
      if (!result.more) break;
      if (result.retryAfterMs) await new Promise(resolve => setTimeout(resolve, Math.min(result.retryAfterMs!, 30_000)));
    }
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  const results = await Promise.all([
    db.from(table("content_requests")).select("status,current_step,research_outcome,revision_rounds,actual_cost_cents,reserved_cost_cents,cost_complete,failure_reason").eq("id", id).single(),
    db.from(table("sources")).select("id,url,fetch_status,included,relevance_score").eq("request_id", id),
    db.from(table("article_versions")).select("id,version,parent_version_id,origin,title,body_md,claim_map,word_count,created_at").eq("request_id", id).order("version"),
    db.from(table("evaluations")).select("id,article_version_id,status,computed,judged,judge_verdict,judge_overruled,created_at").eq("request_id", id).order("created_at"),
    db.from(table("channel_outputs")).select("*").eq("request_id", id),
    db.from(table("model_calls")).select("id,step,model,purpose,input_tokens,output_tokens,web_searches,cost_cents,latency_ms,outcome,error,created_at").eq("request_id", id).order("created_at"),
    db.from(table("images")).select("id,licence,query_used").eq("request_id", id),
  ]);
  const keys = ["request", "sources", "versions", "evaluations", "channels", "calls", "images"];
  for (const [i, result] of results.entries()) { report[keys[i]!] = result.data; if (result.error) (report.readErrors ??= []).push({ key: keys[i], error: result.error.message }); }
  report.channelCounts = (report.channels ?? []).map((c: any) => ({ channel: c.channel, chars: c.channel === "x" ? countXCharacters(c.body) : c.body.length, words: countWords(c.body), format: c.format_check, hasVisibleMarkers: /\[E\d+\]/.test(c.body) }));
  report.finishedAt = new Date().toISOString(); report.totalMs = Date.now() - started;
  if (report.firstDraftMs && report.angleChosenMs) report.angleToDraftMs = report.firstDraftMs - report.angleChosenMs;
  save();
  console.log(JSON.stringify({ case: name, id, request: report.request, firstDraftMs: report.firstDraftMs, angleToDraftMs: report.angleToDraftMs, totalMs: report.totalMs, readErrors: report.readErrors, error: report.error }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
