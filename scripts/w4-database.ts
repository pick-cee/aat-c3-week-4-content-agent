/** Extra Week 4 checks. Transactions roll back; the concurrency fixture is removed in finally. No email provider is called. */
import "dotenv/config";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const options = { connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 20000 };
const evidence: any[] = [];
function pass(name: string, detail?: unknown) { evidence.push({ name, passed: true, detail }); console.log("PASS " + name + (detail ? " " + JSON.stringify(detail) : "")); }
async function main() {
  const db = new Client(options), second = new Client(options), guard = new Client(options);
  await Promise.all([db.connect(), second.connect(), guard.connect()]);
  const req = randomUUID(), version = randomUUID(), output = randomUUID(), token = `w4-db-${req}`;
  let committed = false;
  try {
    await db.query("begin");
    const profile = (await db.query("select id from content_agent.profiles where role in ('reviewer','admin') limit 1")).rows[0];
    assert(profile);
    await db.query("insert into content_agent.content_requests(id,created_by,idea,target_audience,status,current_step,budget_cents,submit_token,hold_in_queue) values($1,$2,'W4 disposable database fixture - DO NOT SEND','Test harness','researching','discover',5,$3,true)", [req, profile.id, token]);
    async function rejects(sql: string, args: unknown[], code: string, name: string) {
      await db.query("savepoint expected_rejection");
      let error: any;
      try { await db.query(sql, args); } catch (caught) { error = caught; }
      await db.query("rollback to savepoint expected_rejection");
      assert.equal(error?.code, code, name);
      pass(name, { code: error.code, message: error.message });
    }
    await rejects("insert into content_agent.content_requests(created_by,idea,target_audience,submit_token) values($1,'Duplicate fixture','QA',$2)", [profile.id, token], "23505", "Duplicate submission token cannot create a second request");
    await db.query("select * from public.claim_request_lease($1,'crashed-worker',75)", [req]);
    const refused = (await db.query("select public.reserve_model_call($1,$2,'draft','claude-sonnet-5',9,100000000,'crashed-worker') result", [randomUUID(), req])).rows[0].result;
    assert.equal(refused.allowed, false); pass("Five-cent request cannot reserve a nine-cent draft call", refused);
    assert.equal((await db.query("select count(*)::int n from content_agent.model_calls where request_id=$1", [req])).rows[0].n, 0);
    await db.query("update content_agent.content_requests set runner_lease_until=now()-interval '1 second' where id=$1", [req]);
    const recovered = await db.query("select * from public.claim_request_lease($1,'replacement-worker',75)", [req]);
    assert.equal(recovered.rowCount, 1); assert.equal(recovered.rows[0].current_step, "discover");
    pass("Expired worker lease resumes the stored step");
    assert.equal((await db.query("select public.renew_request_lease($1,'crashed-worker',75) ok", [req])).rows[0].ok, false);
    pass("Crashed worker cannot renew a lease now owned by its replacement");
    await db.query("select public.release_request_lease($1,'replacement-worker')", [req]);
    await db.query("insert into content_agent.article_versions(id,request_id,version,title,body_md,headings) values($1,$2,1,'W4 fixture','# W4 fixture','[]')", [version, req]);
    await db.query("insert into content_agent.channel_outputs(id,request_id,article_version_id,channel,version,body) values($1,$2,$3,'newsletter',1,'Disposable test content')", [output, req, version]);
    await rejects("insert into content_agent.publish_queue(request_id,channel_output_id,channel,kind,scheduled_for,idempotency_key) values($1,$2,'newsletter','delivering',now(),$3)", [req, output, token], "23502", "A queue item without approved_by is rejected by PostgreSQL");
    await db.query("update content_agent.content_requests set status='content_review' where id=$1", [req]);
    await db.query("insert into content_agent.evaluations(request_id,article_version_id,status) values($1,$2,'pass')", [req, version]);
    const queue = (await db.query("select * from public.approve_content_channel($1,$2,$3,null,null)", [req, output, profile.id])).rows[0];
    assert.equal(queue.status, "held");
    // Keep the fixture committed only long enough to exercise two real database sessions.
    await db.query("commit"); committed = true;
    await guard.query("begin");
    await guard.query("select id from content_agent.publish_queue where status='queued' and id<>$1 for update", [queue.id]);
    await db.query("update content_agent.publish_queue set status='queued',scheduled_for=now()-interval '1 second' where id=$1", [queue.id]);
    await Promise.all([db.query("begin"), second.query("begin")]);
    const claims = await Promise.all([db.query("select * from public.claim_due_publish_item()"), second.query("select * from public.claim_due_publish_item()")]);
    const claimed = claims.flatMap(result => result.rows);
    assert.equal(claimed.length, 1); assert.equal(claimed[0].id, queue.id); assert.equal(claimed[0].attempt, 1);
    await Promise.all([db.query("commit"), second.query("commit")]);
    pass("Two simultaneous database release claims return exactly one item with attempt=1", { claims: claims.map(result => result.rowCount), attempt: claimed[0].attempt });
    await db.query("begin");
    const recipient = randomUUID();
    await db.query("insert into content_agent.publish_deliveries(queue_id,recipient_id,channel,status,created_at) values($1,$2,'newsletter','pending',now()-interval '10 minutes')", [queue.id, recipient]);
    await rejects("insert into content_agent.publish_deliveries(queue_id,recipient_id,channel) values($1,$2,'newsletter')", [queue.id, recipient], "23505", "A recipient has only one delivery record per queue item");
    await db.query("select * from public.sweep_stuck_deliveries(5)");
    const delivery = (await db.query("select status,error_code from content_agent.publish_deliveries where queue_id=$1", [queue.id])).rows[0];
    assert.equal(delivery.status, "uncertain"); assert.equal(delivery.error_code, "no_provider_response");
    pass("Timed-out delivery becomes uncertain, not retryable failed", delivery);
    await db.query("rollback");
    const anonHeaders = { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`, "content-type": "application/json" };
    for (const [name, args] of [["claim_due_publish_item", {}], ["bump_counter", { p_scope: "ip", p_scope_key: token, p_window: "hour", p_metric: "request_created", p_cents: 0 }], ["add_request_cost", { p_request_id: req, p_cents: 999 }]] as const) {
      const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: anonHeaders, body: JSON.stringify(args) });
      const body = await response.json();
      assert([401, 403].includes(response.status), `${name} returned ${response.status}: ${JSON.stringify(body)}`);
      pass(`Anonymous REST call to ${name} is refused`, { status: response.status, code: body.code });
    }
    const cron = await fetch("http://localhost:3000/api/cron/release", { method: "POST" });
    assert.equal(cron.status, 401); pass("Cron without a secret returns 401");
  } finally {
    await Promise.all([db.query("rollback").catch(() => {}), second.query("rollback").catch(() => {}), guard.query("rollback").catch(() => {})]);
    if (committed) await db.query("delete from content_agent.content_requests where id=$1 and submit_token=$2", [req, token]);
    await Promise.all([db.end(), second.end(), guard.end()]);
    mkdirSync("tmp/w4-tests", { recursive: true });
    writeFileSync("tmp/w4-tests/database-safety.json", JSON.stringify(evidence, null, 2));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
