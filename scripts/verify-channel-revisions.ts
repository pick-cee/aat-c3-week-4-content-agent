/** Real database checks in a rolled-back transaction. No model calls or sends. */
import "dotenv/config";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

async function main() {
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await db.connect();
  let checks = 0;
  const check = (ok: unknown, message: string) => { assert(ok, message); checks++; console.log("PASS " + message); };
  const reject = async (sql: string, args: unknown[], message: string) => {
    await db.query("savepoint expected_rejection");
    let rejected = false;
    try { await db.query(sql, args); } catch { rejected = true; }
    await db.query("rollback to savepoint expected_rejection");
    check(rejected, message);
  };
  try {
    await db.query("begin");
    await db.query("set local lock_timeout='5s'");
    await db.query("set local statement_timeout='30s'");
    await db.query(readFileSync("supabase/migrations/0031_channel_revisions.sql", "utf8"));
    const actor = (await db.query("select id from content_agent.profiles where role in ('reviewer','admin') limit 1")).rows[0].id;
    const req = randomUUID(), article = randomUUID(), newsletter = randomUUID(), linkedin = randomUUID();
    await db.query("insert into content_agent.content_requests(id,created_by,idea,target_audience,channels,status,budget_cents,hold_in_queue) values($1,$2,'Revision verification','Test',ARRAY['newsletter','linkedin']::content_agent.channel_name[],'content_review',150,true)", [req, actor]);
    await db.query("insert into content_agent.article_versions(id,request_id,version,title,body_md,headings) values($1,$2,1,'Hiring','# Hiring','[]')", [article, req]);
    await db.query("insert into content_agent.evaluations(request_id,article_version_id,status) values($1,$2,'pass')", [req, article]);
    for (const [id, channel] of [[newsletter, "newsletter"], [linkedin, "linkedin"]]) {
      await db.query("insert into content_agent.channel_outputs(id,request_id,article_version_id,channel,version,body) values($1,$2,$3,$4,1,'Original copy')", [id, req, article, channel]);
      await db.query("select * from public.approve_content_channel($1,$2,$3,null,null)", [req, id, actor]);
    }
    const args = [req, newsletter, actor, "Add a sign-off. Keep the opening."];
    await reject("select public.request_channel_revision($1,$2,$3,$4)", [req, newsletter, randomUUID(), args[3]], "Unknown actor cannot request a revision");
    await db.query("update content_agent.publish_queue set status='publishing' where channel_output_id=$1", [newsletter]);
    await reject("select public.request_channel_revision($1,$2,$3,$4)", args, "An in-flight send cannot be replaced");
    await db.query("update content_agent.publish_queue set status='held' where channel_output_id=$1", [newsletter]);
    const job = (await db.query("select public.request_channel_revision($1,$2,$3,$4) id", args)).rows[0].id;
    const queues = (await db.query("select channel,status from content_agent.publish_queue where request_id=$1", [req])).rows;
    check(queues.find(q => q.channel === "newsletter").status === "cancelled" && queues.find(q => q.channel === "linkedin").status === "held", "Only the revised channel's pending send is withdrawn");
    await reject("select public.request_channel_revision($1,$2,$3,$4)", args, "Repeated submission cannot start a second revision");
    await db.query("select * from public.claim_request_lease($1,'revision-test',75)", [req]);
    const payload = { body: "Original copy\n\nBest,\nKoya", subject: "Hiring", hashtags: [], cta: null, includes_link: false, link_url: null, char_count: 25, claim_map: [], format_check: { passed: true, checks: [] }, status: "draft", model_used: "test", input_tokens: 0, output_tokens: 0 };
    await reject("select * from public.save_channel_revision($1,$2,$3,$4)", [req, job, "stale-lease", payload], "A stale worker cannot save a revision");
    await reject("select * from public.save_channel_revision($1,$2,$3,$4)", [req, job, "revision-test", { ...payload, status: "approved" }], "Generated revisions cannot inherit approval");
    const saveArgs = [req, job, "revision-test", payload];
    const saved = (await db.query("select * from public.save_channel_revision($1,$2,$3,$4)", saveArgs)).rows[0];
    const repeated = (await db.query("select * from public.save_channel_revision($1,$2,$3,$4)", saveArgs)).rows[0];
    check(saved.id === repeated.id && saved.version === 2 && saved.status === "draft" && saved.article_version_id === article && saved.parent_output_id === newsletter, "Retry saves exactly one unapproved version against the same article");
    check((await db.query("select count(*)::int n from content_agent.article_versions where request_id=$1", [req])).rows[0].n === 1, "The article was not rewritten");
    check((await db.query("select count(*)::int n from content_agent.channel_outputs where request_id=$1 and channel='linkedin' and status='approved'", [req])).rows[0].n === 1, "Other channel copy and approval are preserved");
    await db.query("update content_agent.publish_queue set status='posted_manually',platform_url='https://example.test/post' where channel_output_id=$1", [linkedin]);
    check((await db.query("select public.settle_content_request($1) status", [req])).rows[0].status === null, "A completed sibling cannot hide an unreviewed revision");
    await reject("select * from public.approve_content_channel($1,$2,$3,null,null)", [req, newsletter, actor], "The superseded channel cannot be approved again");
    await db.query("select * from public.approve_content_channel($1,$2,$3,null,null)", [req, saved.id, actor]);
    check((await db.query("select status from content_agent.publish_queue where channel_output_id=$1", [saved.id])).rows[0].status === "held", "Fresh approval creates a separate queue item");
    // Make this uncommitted fixture the earliest due item. No publisher can see it.
    await db.query("update content_agent.publish_queue set status='queued',scheduled_for='-infinity' where channel_output_id=$1", [saved.id]);
    const claimed = (await db.query("select * from public.claim_due_publish_item()")).rows[0];
    check(claimed?.channel_output_id === saved.id && claimed.attempt === 1 && claimed.status === "publishing", "Delivery can claim the freshly approved revision exactly once");
    await db.query("update content_agent.publish_queue set status='published',platform_post_id='test-only-receipt' where channel_output_id=$1", [saved.id]);
    await db.query("select public.settle_content_request($1)", [req]);
    await db.query("select public.request_channel_revision($1,$2,$3,$4)", [req, saved.id, actor, "Shorten the opening"]);
    check((await db.query("select status from content_agent.publish_queue where channel_output_id=$1", [saved.id])).rows[0].status === "published", "Revising published copy preserves the historical delivery");
    const permissions = (await db.query("select has_function_privilege('anon','public.request_channel_revision(uuid,uuid,uuid,text)','execute') anon,has_function_privilege('authenticated','public.save_channel_revision(uuid,uuid,text,jsonb)','execute') authenticated")).rows[0];
    check(!permissions.anon && !permissions.authenticated, "Revision mutations are service-role only");
    console.log(`${checks} channel revision checks passed; all changes rolled back.`);
  } finally { await db.query("rollback"); await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
