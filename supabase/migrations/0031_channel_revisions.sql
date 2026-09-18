-- A channel revision is durable work against an immutable article snapshot.
alter table content_agent.content_requests add column if not exists channel_revision jsonb;
alter table content_agent.channel_outputs add column if not exists revision_job_id uuid;
alter table content_agent.channel_outputs add column if not exists parent_output_id uuid references content_agent.channel_outputs(id);
alter table content_agent.channel_outputs add column if not exists revision_note text;
create unique index if not exists channel_revision_job_unique on content_agent.channel_outputs(revision_job_id) where revision_job_id is not null;
create or replace view public.ca_content_requests with (security_invoker=true) as select * from content_agent.content_requests;
create or replace view public.ca_channel_outputs with (security_invoker=true) as select * from content_agent.channel_outputs;

create or replace function public.request_channel_revision(p_request_id uuid,p_output_id uuid,p_actor_id uuid,p_note text)
returns uuid language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
declare req content_requests; old channel_outputs; job uuid := gen_random_uuid();
begin
  perform 1 from profiles where id=p_actor_id and role in ('reviewer','admin');
  if not found then raise exception 'A reviewer or admin must request this revision'; end if;
  if nullif(trim(p_note),'') is null or length(p_note)>2000 then raise exception 'Describe the change in 1 to 2,000 characters'; end if;
  select * into req from content_requests where id=p_request_id and deleted_at is null for update;
  if not found or req.status not in ('content_review','scheduled','published') or req.channel_revision is not null then
    raise exception 'This request is not ready for a channel revision. Refresh its progress';
  end if;
  select * into old from channel_outputs where id=p_output_id and request_id=p_request_id for update;
  if not found or old.article_version_id<>(select id from article_versions where request_id=p_request_id order by version desc limit 1)
    or exists(select 1 from channel_outputs where request_id=p_request_id and channel=old.channel and version>old.version) then
    raise exception 'This channel changed. Refresh before requesting a revision';
  end if;
  -- Serialize with delivery claims. Never replace content whose send is unresolved.
  perform 1 from publish_queue where request_id=p_request_id for update;
  if exists(select 1 from publish_queue where request_id=p_request_id and status in ('publishing','uncertain','partially_delivered')) then
    raise exception 'Resolve the current delivery before requesting a revision';
  end if;
  update publish_queue set status='cancelled'
    where request_id=p_request_id and channel=old.channel
      and status in ('held','queued','blocked_not_connected','failed','awaiting_manual_post');
  insert into approvals(request_id,subject_type,subject_id,actor_id,decision,note)
    values(p_request_id,'channel_output',p_output_id,p_actor_id,'revision_requested',trim(p_note));
  update content_requests set channel_revision=jsonb_build_object('id',job,'outputId',old.id,
      'articleVersionId',old.article_version_id,'channel',old.channel,'note',trim(p_note)),
    status='adapting',current_step='adapt',step_attempts=0,retry_after=null,
    runner_lease_id=null,runner_lease_until=null,failed_step=null,failure_reason=null,failure_detail=null
    where id=p_request_id;
  return job;
end; $$;

-- Save and complete together; retries cannot create another version or restore approval.
create or replace function public.save_channel_revision(p_request_id uuid,p_job_id uuid,p_lease_id text,p_output jsonb)
returns setof content_agent.channel_outputs language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
declare req content_requests; old channel_outputs; saved channel_outputs;
begin
  select * into req from content_requests where id=p_request_id for update;
  if req.deleted_at is not null or req.status='cancelled' then raise exception 'This request was stopped'; end if;
  select * into saved from channel_outputs where request_id=p_request_id and revision_job_id=p_job_id;
  if found then return next saved; return; end if;
  if req.id is null or req.status<>'adapting' or req.channel_revision is null
    or req.channel_revision->>'id'<>p_job_id::text or p_lease_id is null
    or req.runner_lease_id is distinct from p_lease_id or req.runner_lease_until<=now() then
    raise exception 'The channel revision lease was lost';
  end if;
  select * into old from channel_outputs where id=(req.channel_revision->>'outputId')::uuid;
  if old.article_version_id<>(select id from article_versions where request_id=p_request_id order by version desc limit 1) then
    raise exception 'The article changed during revision';
  end if;
  if p_output->>'status' not in ('draft','format_failed') or nullif(trim(p_output->>'body'),'') is null then
    raise exception 'A revision must be saved as an unapproved draft';
  end if;
  insert into channel_outputs(request_id,article_version_id,channel,version,subject,body,hashtags,cta,
    includes_link,link_url,char_count,claim_map,format_check,status,auto_trimmed,model_used,input_tokens,output_tokens,
    revision_job_id,parent_output_id,revision_note)
  values(p_request_id,old.article_version_id,old.channel,
    (select coalesce(max(version),0)+1 from channel_outputs where request_id=p_request_id and channel=old.channel),
    p_output->>'subject',p_output->>'body',array(select jsonb_array_elements_text(p_output->'hashtags')),p_output->>'cta',
    (p_output->>'includes_link')::boolean,p_output->>'link_url',(p_output->>'char_count')::int,p_output->'claim_map',
    p_output->'format_check',(p_output->>'status')::channel_output_status,coalesce((p_output->>'auto_trimmed')::boolean,false),
    p_output->>'model_used',(p_output->>'input_tokens')::int,(p_output->>'output_tokens')::int,
    p_job_id,old.id,req.channel_revision->>'note') returning * into saved;
  update content_requests set channel_revision=null,
    status=case when exists(select 1 from channel_outputs where request_id=p_request_id and status='approved')
      then 'scheduled'::request_status else 'content_review'::request_status end,
    current_step=null,step_attempts=0,retry_after=null,failure_reason=null,failure_detail=null,failed_step=null
    where id=p_request_id;
  return next saved;
end; $$;

-- Lock the parent before the queue item, matching review actions. Other queued
-- channels wait while revision runs; their approval and schedule are untouched.
create or replace function content_agent.claim_due_publish_item()
returns setof content_agent.publish_queue language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
declare request_id_to_claim uuid; item_id uuid;
begin
  select r.id into request_id_to_claim from content_requests r
    where r.deleted_at is null and r.status in ('scheduled','publishing','published')
      and exists(select 1 from publish_queue q where q.request_id=r.id and q.status='queued' and q.scheduled_for<=now())
    order by (select min(q.scheduled_for) from publish_queue q where q.request_id=r.id and q.status='queued')
    for update of r skip locked limit 1;
  if request_id_to_claim is null then return; end if;
  select id into item_id from publish_queue where request_id=request_id_to_claim and status='queued' and scheduled_for<=now()
    order by scheduled_for for update skip locked limit 1;
  return query update publish_queue set status='publishing',attempt=attempt+1,reserved_at=now() where id=item_id returning *;
end; $$;

-- A completed sibling must not close a request while its revised copy needs review.
create or replace function public.settle_content_request(p_request_id uuid)
returns text language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
declare req content_requests; next_status request_status;
begin
  select * into req from content_requests where id=p_request_id for update;
  if not found or req.status not in ('scheduled','publishing') or req.channel_revision is not null then return null; end if;
  if not exists(select 1 from publish_queue where request_id=p_request_id) then return null; end if;
  if exists(select 1 from publish_queue where request_id=p_request_id and status in
    ('queued','held','publishing','awaiting_manual_post','uncertain','blocked_not_connected')) then return null; end if;
  if exists(select 1 from channel_outputs o where o.request_id=p_request_id and o.status in ('draft','format_failed')
    and o.article_version_id=(select id from article_versions where request_id=p_request_id order by version desc limit 1)
    and not exists(select 1 from channel_outputs n where n.request_id=p_request_id and n.channel=o.channel and n.version>o.version)) then return null; end if;
  next_status := case when exists(select 1 from publish_queue where request_id=p_request_id and status in
    ('published','published_dry_run','posted_manually','partially_delivered')) then 'published'::request_status else 'cancelled'::request_status end;
  update content_requests set status=next_status,current_step=null where id=p_request_id;
  return next_status::text;
end; $$;
revoke execute on function public.request_channel_revision(uuid,uuid,uuid,text),public.save_channel_revision(uuid,uuid,text,jsonb),public.settle_content_request(uuid) from public,anon,authenticated;
grant execute on function public.request_channel_revision(uuid,uuid,uuid,text),public.save_channel_revision(uuid,uuid,text,jsonb),public.settle_content_request(uuid) to service_role;
notify pgrst,'reload schema';
