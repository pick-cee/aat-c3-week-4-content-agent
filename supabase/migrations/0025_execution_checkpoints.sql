-- Durable retry deadlines, bounded attempts (including killed workers), and
-- atomic call accounting. All RPCs are service-role only.
alter table content_agent.content_requests
  add column if not exists retry_after timestamptz,
  add column if not exists step_started_at timestamptz,
  add column if not exists replan_note text,
  add column if not exists reserved_cost_cents numeric not null default 0;
alter table content_agent.model_calls
  add column if not exists cache_creation_tokens int not null default 0,
  add column if not exists input_hash text,
  add column if not exists response_json jsonb,
  add column if not exists cost_ceiling_cents numeric not null default 0;
create index if not exists model_calls_checkpoint on content_agent.model_calls(request_id, input_hash)
  where response_json is not null;

create or replace view public.ca_content_requests with (security_invoker=true) as
  select * from content_agent.content_requests;
create or replace view public.ca_model_calls with (security_invoker=true) as
  select * from content_agent.model_calls;

create or replace function content_agent.claim_request_lease(
  p_request_id uuid, p_lease_id text, p_lease_secs int default 75
) returns setof content_agent.content_requests
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update content_requests set
    runner_lease_until = now() + make_interval(secs => least(greatest(p_lease_secs,15),75)),
    runner_lease_id = p_lease_id,
    step_attempts = step_attempts + 1,
    step_started_at = now()
  where id = p_request_id and deleted_at is null
    and status in ('researching','drafting','evaluating','revising','adapting')
    and (retry_after is null or retry_after <= now())
    and (runner_lease_until is null or runner_lease_until < now())
  returning *;
$$;

create or replace function content_agent.claim_next_runnable_request(
  p_lease_id text, p_lease_secs int default 90
) returns setof content_agent.content_requests
language sql volatile security definer set search_path = content_agent, public, extensions as $$
  update content_requests set
    runner_lease_until = now() + make_interval(secs => least(greatest(p_lease_secs,15),75)),
    runner_lease_id = p_lease_id,
    step_attempts = step_attempts + 1,
    step_started_at = now()
  where id = (
    select id from content_requests
    where deleted_at is null
      and status in ('researching','drafting','evaluating','revising','adapting')
      and (retry_after is null or retry_after <= now())
      and (runner_lease_until is null or runner_lease_until < now())
    order by updated_at for update skip locked limit 1
  ) returning *;
$$;

create or replace function content_agent.record_model_call(p_call jsonb, p_complete boolean default true)
returns numeric language plpgsql volatile security definer
set search_path = content_agent, public, extensions as $$
declare inserted_id uuid; charge numeric; request_uuid uuid;
begin
  charge := greatest(0, (p_call->>'cost_cents')::numeric);
  request_uuid := (p_call->>'request_id')::uuid;
  insert into model_calls(id, request_id, step, purpose, model, input_tokens, output_tokens,
    cache_read_tokens, cache_creation_tokens, web_searches, cost_cents, outcome,
    error, latency_ms, input_hash, response_json, cost_ceiling_cents)
  values ((p_call->>'id')::uuid, request_uuid, p_call->>'step', p_call->>'purpose',
    p_call->>'model', (p_call->>'input_tokens')::int, (p_call->>'output_tokens')::int,
    (p_call->>'cache_read_tokens')::int, (p_call->>'cache_creation_tokens')::int,
    (p_call->>'web_searches')::int, charge, (p_call->>'outcome')::model_call_outcome,
    p_call->>'error', (p_call->>'latency_ms')::int, p_call->>'input_hash',
    nullif(p_call->'response_json', 'null'::jsonb), coalesce((p_call->>'cost_ceiling_cents')::numeric,0))
  on conflict (id) do nothing returning id into inserted_id;
  if inserted_id is not null and request_uuid is not null then
    -- Round the TOTAL, never each sub-cent embedding batch.
    update content_requests set
      actual_cost_cents = ceil((select coalesce(sum(cost_cents),0) from model_calls where request_id = request_uuid)),
      reserved_cost_cents = (select coalesce(sum(cost_ceiling_cents),0) from model_calls where request_id = request_uuid),
      cost_complete = cost_complete and p_complete
    where id = request_uuid;
    perform bump_counter('global','all','month','cents_spent',ceil(charge)::int);
  end if;
  return charge;
end;
$$;
create or replace function public.record_model_call(p_call jsonb, p_complete boolean default true)
returns numeric language sql volatile as $$
  select content_agent.record_model_call(p_call, p_complete);
$$;

-- Selecting an angle and advancing the request must be one transaction.
create or replace function public.choose_content_angle(p_request_id uuid, p_angle_id uuid)
returns boolean language plpgsql volatile security definer
set search_path = content_agent, public, extensions as $$
begin
  perform 1 from content_requests where id = p_request_id
    and status = 'plan_review' and deleted_at is null for update;
  if not found then return false; end if;
  perform 1 from angles where id = p_angle_id and request_id = p_request_id and not invalidated;
  if not found then return false; end if;
  update angles set chosen = false where request_id = p_request_id;
  update angles set chosen = true where id = p_angle_id;
  update content_requests set status = 'drafting', current_step = 'draft', step_attempts = 0,
    failure_reason = null, failure_detail = null, retry_after = null where id = p_request_id;
  return true;
end;
$$;

revoke execute on function content_agent.claim_request_lease(uuid,text,int),
  content_agent.claim_next_runnable_request(text,int),
  content_agent.record_model_call(jsonb,boolean), public.record_model_call(jsonb,boolean),
  public.choose_content_angle(uuid,uuid) from public, anon, authenticated;
grant execute on function content_agent.claim_request_lease(uuid,text,int),
  content_agent.claim_next_runnable_request(text,int),
  content_agent.record_model_call(jsonb,boolean), public.record_model_call(jsonb,boolean),
  public.choose_content_angle(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
