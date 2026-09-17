-- Reserve BEFORE contacting a paid provider. A killed worker leaves a durable
-- allowance rather than silently losing an incurred charge.
alter table content_agent.model_calls add column if not exists usage_complete boolean not null default true;
alter table content_agent.content_requests add column if not exists untracked_cost boolean not null default false;
update content_agent.content_requests set untracked_cost=true where not cost_complete and reserved_cost_cents=0;
create or replace view public.ca_content_requests with (security_invoker=true) as select * from content_agent.content_requests;
create or replace view public.ca_model_calls with (security_invoker=true) as select * from content_agent.model_calls;

create or replace function public.reserve_model_call(p_id uuid,p_request_id uuid,p_step text,p_model text,p_ceiling numeric,p_monthly_limit int,p_lease_id text default null)
returns jsonb language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
declare req content_requests; spent numeric; month_total numeric;
begin
  perform pg_advisory_xact_lock(4872311905::bigint);
  select * into req from content_requests where id=p_request_id for update;
  if not found or req.deleted_at is not null or req.status not in ('researching','drafting','evaluating','revising','adapting') then raise exception 'The request is not running'; end if;
  if p_lease_id is null or req.runner_lease_id is distinct from p_lease_id or req.runner_lease_until < now() then raise exception 'The worker lease is no longer active'; end if;
  if req.untracked_cost then raise exception 'Untracked provider usage must be reconciled before spending more'; end if;
  if p_ceiling < 0 or p_monthly_limit <= 0 then raise exception 'Invalid budget configuration'; end if;
  if exists(select 1 from model_calls where id=p_id) then raise exception 'This provider operation already started'; end if;
  spent := req.actual_cost_cents+req.reserved_cost_cents;
  if spent+p_ceiling>req.budget_cents then return jsonb_build_object('allowed',false,'spent',spent,'budget',req.budget_cents,'scope','request'); end if;
  select coalesce(sum(cost_cents+cost_ceiling_cents),0) into month_total from model_calls where created_at>=date_trunc('month',now());
  month_total := month_total+(select coalesce(sum(cost_cents),0) from retained_spend where month=date_trunc('month',now())::date);
  if month_total+p_ceiling>p_monthly_limit then return jsonb_build_object('allowed',false,'spent',month_total,'budget',p_monthly_limit,'scope','workspace'); end if;
  insert into model_calls(id,request_id,step,model,input_tokens,output_tokens,cache_read_tokens,web_searches,cost_cents,outcome,error,cost_ceiling_cents,usage_complete)
    values(p_id,p_request_id,p_step,p_model,0,0,0,0,0,'failed','Provider call started; final usage is not yet confirmed',p_ceiling,false);
  update content_requests set reserved_cost_cents=reserved_cost_cents+p_ceiling,cost_complete=false where id=p_request_id;
  return jsonb_build_object('allowed',true);
end; $$;

create or replace function content_agent.record_model_call(p_call jsonb,p_complete boolean default true)
returns numeric language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
declare call_uuid uuid; request_uuid uuid; charge numeric; previous_charge numeric;
begin
  perform pg_advisory_xact_lock(4872311905::bigint);
  call_uuid:=(p_call->>'id')::uuid; request_uuid:=(p_call->>'request_id')::uuid;
  charge:=greatest(0,(p_call->>'cost_cents')::numeric);
  perform 1 from content_requests where id=request_uuid for update;
  select cost_cents into previous_charge from model_calls where id=call_uuid for update;
  if exists(select 1 from model_calls where id=call_uuid and usage_complete) then return coalesce(previous_charge,0); end if;
  insert into model_calls(id,request_id,step,purpose,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,web_searches,cost_cents,outcome,error,latency_ms,input_hash,response_json,cost_ceiling_cents,usage_complete)
    values(call_uuid,request_uuid,p_call->>'step',p_call->>'purpose',p_call->>'model',
      (p_call->>'input_tokens')::int,(p_call->>'output_tokens')::int,coalesce((p_call->>'cache_read_tokens')::int,0),coalesce((p_call->>'cache_creation_tokens')::int,0),
      coalesce((p_call->>'web_searches')::int,0),charge,(p_call->>'outcome')::model_call_outcome,p_call->>'error',(p_call->>'latency_ms')::int,p_call->>'input_hash',
      nullif(p_call->'response_json','null'::jsonb),case when p_complete then 0 else coalesce((p_call->>'cost_ceiling_cents')::numeric,0) end,p_complete)
    on conflict(id) do update set purpose=excluded.purpose,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
      cache_read_tokens=excluded.cache_read_tokens,cache_creation_tokens=excluded.cache_creation_tokens,web_searches=excluded.web_searches,
      cost_cents=excluded.cost_cents,outcome=excluded.outcome,error=excluded.error,latency_ms=excluded.latency_ms,input_hash=excluded.input_hash,
      response_json=excluded.response_json,cost_ceiling_cents=excluded.cost_ceiling_cents,usage_complete=excluded.usage_complete;
  if request_uuid is not null then
    update content_requests set
      actual_cost_cents=ceil((select coalesce(sum(cost_cents),0) from model_calls where request_id=request_uuid)),
      reserved_cost_cents=(select coalesce(sum(cost_ceiling_cents),0) from model_calls where request_id=request_uuid),
      cost_complete=not untracked_cost and (select bool_and(usage_complete) from model_calls where request_id=request_uuid)
      where id=request_uuid;
    perform bump_counter('global','all','month','cents_spent',greatest(0,ceil(charge-coalesce(previous_charge,0)))::int);
  end if;
  return charge;
end; $$;
revoke execute on function public.reserve_model_call(uuid,uuid,text,text,numeric,int,text),content_agent.record_model_call(jsonb,boolean) from public,anon,authenticated;
grant execute on function public.reserve_model_call(uuid,uuid,text,text,numeric,int,text),content_agent.record_model_call(jsonb,boolean) to service_role;
notify pgrst,'reload schema';
