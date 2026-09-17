/** Applies pending migrations and tests their behavior in ONE rolled-back transaction.
 * No provider calls, emails, or durable test records. Run before db:push.
 */
import { config } from "dotenv";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import assert from "node:assert/strict";
config({ quiet: true });

async function main() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
  await client.connect();
  let checks = 0;
  const check = (condition: unknown, message: string) => { assert(condition, message); checks++; console.log("PASS " + message); };
  const query = (sql: string, values?: unknown[]) => client.query(sql, values);
  const rejects = async (sql: string, values: unknown[], message: string) => {
    await query("savepoint rejection");
    let failed = false;
    try { await query(sql, values); } catch { failed = true; }
    await query("rollback to savepoint rejection");
    check(failed, message);
  };
  try {
    await query("begin");
    await query("set local lock_timeout='3s'");
    await query("set local statement_timeout='25s'");
    const done = new Set((await query("select filename from public._content_agent_migrations")).rows.map(r=>r.filename));
    for (const file of readdirSync("supabase/migrations").filter(f=>f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      await query(readFileSync("supabase/migrations/" + file,"utf8"));
      console.log("Validated migration " + file);
    }
    const profile = (await query("select id from content_agent.profiles where role in ('reviewer','admin') limit 1")).rows[0];
    assert(profile, "Provision a reviewer before integration checks.");
    await query("select set_config('request.jwt.claim.sub',$1,true)", [profile.id]);
    const originalDemo = (await query("select is_demo from content_agent.profiles where id=$1", [profile.id])).rows[0].is_demo;
    await query("update content_agent.profiles set is_demo=true where id=$1", [profile.id]);
    const demoRights = (await query("select content_agent.is_signed_in() member, content_agent.can_approve() reviewer")).rows[0];
    check(!demoRights.member && !demoRights.reviewer, "Public demo credentials cannot read private workspace data through RLS");
    await query("update content_agent.profiles set is_demo=false where id=$1", [profile.id]);
    check((await query("select content_agent.is_signed_in() member")).rows[0].member, "Provisioned agency members retain authenticated access");
    await query("update content_agent.profiles set is_demo=$2 where id=$1", [profile.id, originalDemo]);
    const req = randomUUID(), angle = randomUUID(), version = randomUUID(), output = randomUUID();
    const consume = async () => (await query("select public.consume_rate_limit('ip',$1,'hour','test',1) result", [req])).rows[0].result.allowed;
    check(await consume() && !(await consume()), "Rate-limit consumption atomically refuses requests over the limit");
    await query("insert into content_agent.content_requests(id,created_by,idea,target_audience,status,current_step,budget_cents,hold_in_queue) values($1,$2,'Rollback verification request','Editorial teams','researching','discover',100,true)",[req,profile.id]);
    const claimed = (await query("select * from public.claim_request_lease($1,'first',75)",[req])).rows;
    check(claimed.length===1 && claimed[0].step_attempts===1,"Claim increments attempts before work starts");
    check((await query("select * from public.claim_request_lease($1,'second',75)",[req])).rowCount===0,"A second worker cannot claim an active lease");
    const reservedId = randomUUID();
    check((await query("select public.reserve_model_call($1,$2,'draft','claude-sonnet-5',60,100000000,'first') as result",[reservedId,req])).rows[0].result.allowed,"Provider cost is reserved before the external call");
    const denied=(await query("select public.reserve_model_call($1,$2,'draft','claude-sonnet-5',41,100000000,'first') as result",[randomUUID(),req])).rows[0].result;
    check(!denied.allowed && denied.scope==='request',"Concurrent operations cannot exceed the combined request allowance");
    await rejects("select public.reserve_model_call($1,$2,'draft','claude-sonnet-5',1,100000000,'wrong')",[randomUUID(),req],"A worker with a stale lease cannot spend");
    await query("select public.record_model_call($1,true)",[{id:reservedId,request_id:req,step:'draft',model:'claude-sonnet-5',input_tokens:1,output_tokens:1,cost_cents:0.08,outcome:'used'}]);
    const confirmed=(await query("select reserved_cost_cents,cost_complete from content_agent.content_requests where id=$1",[req])).rows[0];
    check(Number(confirmed.reserved_cost_cents)===0 && confirmed.cost_complete,"Confirmed usage replaces the reservation and restores a complete total");
    await query("select public.release_request_lease($1,'first')",[req]);
    await query("update content_agent.content_requests set retry_after=now()+interval '1 minute' where id=$1",[req]);
    check((await query("select * from public.claim_request_lease($1,'third',75)",[req])).rowCount===0,"Retry deadlines stop immediate repeated calls");
    const receipt = { id:randomUUID(),request_id:req,step:"embed",purpose:"test",model:"text-embedding-3-small",input_tokens:100,output_tokens:0,cache_read_tokens:0,cache_creation_tokens:0,web_searches:0,cost_cents:0.08,outcome:"used",cost_ceiling_cents:0 };
    await query("select public.record_model_call($1,true)",[receipt]);
    await query("select public.record_model_call($1,true)",[receipt]);
    await query("select public.record_model_call($1,true)",[{...receipt,id:randomUUID()}]);
    let row = (await query("select actual_cost_cents, cost_complete from content_agent.content_requests where id=$1",[req])).rows[0];
    check(row.actual_cost_cents===1 && row.cost_complete,"Receipts are idempotent and sub-cent batches round only at the total");
    await query("select public.record_model_call($1,false)",[{...receipt,id:randomUUID(),cost_cents:0,cost_ceiling_cents:8,outcome:"failed"}]);
    row=(await query("select cost_complete,reserved_cost_cents from content_agent.content_requests where id=$1",[req])).rows[0];
    check(!row.cost_complete && Number(row.reserved_cost_cents)===8,"Unknown provider charges reserve budget and mark totals incomplete");
    await query("insert into content_agent.angles(id,request_id,label,headline,outline,primary_keyword) values($1,$2,'Guide','A practical editorial guide','[]','editorial guide')",[angle,req]);
    await query("update content_agent.content_requests set status='plan_review', retry_after=null where id=$1",[req]);
    check((await query("select public.choose_content_angle($1,$2) as ok",[req,angle])).rows[0].ok,"Choosing an angle atomically starts drafting");
    check(!(await query("select public.choose_content_angle($1,$2) as ok",[req,angle])).rows[0].ok,"Repeated angle selection cannot restart a draft");
    await query("insert into content_agent.article_versions(id,request_id,version,title,body_md,headings) values($1,$2,1,'Editorial guide','# Editorial guide','[]')",[version,req]);
    await query("insert into content_agent.channel_outputs(id,request_id,article_version_id,channel,version,body) values($1,$2,$3,'linkedin',1,'A test channel version')",[output,req,version]);
    await query("update content_agent.content_requests set status='content_review' where id=$1",[req]);
    await rejects("select * from public.approve_content_channel($1,$2,$3,null,null)",[req,output,profile.id],"Approval refuses an article without evaluation or reviewer override");
    await query("insert into content_agent.evaluations(request_id,article_version_id,status) values($1,$2,'pass')",[req,version]);
    const first=(await query("select * from public.approve_content_channel($1,$2,$3,null,null)",[req,output,profile.id])).rows[0];
    const again=(await query("select * from public.approve_content_channel($1,$2,$3,null,null)",[req,output,profile.id])).rows[0];
    check(first.id===again.id && first.status==='held',"Repeated approval produces one held queue item");
    await rejects("select public.review_content_article($1,$2,'revision_requested','Rewrite this')",[req,profile.id],"Approved content cannot be revised behind the queue");
    await query("select public.stop_content_request($1,$2,true)",[req,profile.id]);
    check((await query("select status from content_agent.publish_queue where id=$1",[first.id])).rows[0].status==='cancelled',"Deleting content cancels its held queue item");
    await rejects("select public.assert_output_approved($1)",[output],"Delivery refuses a deleted request");
    const anonPolicies=(await query("select policyname from pg_policies where schemaname='content_agent' and 'anon'=any(roles) and tablename in ('content_requests','article_versions','sources','images')")).rows;
    check(anonPolicies.length===0,"Private workspace data has no anonymous table policy");
    console.log(`${checks} database checks passed. All changes will now roll back.`);
  } finally {
    await query("rollback").catch(()=>{});
    await client.end();
  }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
