alter table content_agent.content_requests add column if not exists revision_parent_id uuid;
create or replace view public.ca_content_requests with (security_invoker=true) as select * from content_agent.content_requests;

create or replace function public.review_content_article(p_request_id uuid, p_actor_id uuid, p_decision text, p_note text)
returns boolean language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
declare req content_requests; version_id uuid;
begin
  perform 1 from profiles where id=p_actor_id;
  if not found then raise exception 'Workspace membership required'; end if;
  if nullif(trim(p_note),'') is null or length(p_note)>4000 then raise exception 'Add a review note of up to 4,000 characters'; end if;
  select * into req from content_requests where id=p_request_id and deleted_at is null for update;
  if not found or req.status not in ('content_review','needs_human') then raise exception 'This article is locked for review'; end if;
  if exists(select 1 from channel_outputs where request_id=p_request_id and status='approved') then raise exception 'Approved content cannot be changed'; end if;
  select id into version_id from article_versions where request_id=p_request_id order by version desc limit 1;
  if version_id is null then raise exception 'There is no article to review'; end if;
  if p_decision='approved' then
    perform 1 from profiles where id=p_actor_id and role in ('reviewer','admin');
    if not found or req.status <> 'needs_human' then raise exception 'A reviewer must accept this draft'; end if;
  elsif p_decision <> 'revision_requested' then raise exception 'Invalid review decision'; end if;
  insert into approvals(request_id,subject_type,subject_id,actor_id,decision,note)
    values(p_request_id,'article',version_id,p_actor_id,p_decision::approval_decision,trim(p_note));
  update content_requests set
    status=case when p_decision='approved' then 'adapting'::request_status else 'revising'::request_status end,
    current_step=case when p_decision='approved' then 'adapt' else 'revise' end,
    revision_parent_id=version_id, revision_rounds=0, step_attempts=0,
    failure_reason=null,failure_detail=null,failed_step=null,retry_after=null,
    runner_lease_id=null,runner_lease_until=null where id=p_request_id;
  return true;
end; $$;

create or replace function public.set_content_source(p_request_id uuid,p_source_id uuid,p_actor_id uuid,p_included boolean,p_reason text default null)
returns boolean language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
begin
  perform 1 from content_requests where id=p_request_id and status='plan_review' and deleted_at is null for update;
  if not found then raise exception 'Sources can only be changed during research review'; end if;
  update sources set included=p_included,excluded_by=case when p_included then null else p_actor_id end,
    excluded_reason=case when p_included then null else coalesce(p_reason,'Excluded at review') end
    where id=p_source_id and request_id=p_request_id
      and (not p_included or fetch_status in ('ok','too_large','redirected_offsite'));
  if not found then raise exception 'This source is not available'; end if;
  if not p_included then
    update angles set invalidated=true,invalidated_reason='A source supporting this angle was removed. Plan new angles from the remaining sources.'
      where request_id=p_request_id and not invalidated and exists(
        select 1 from excerpts e where e.source_id=p_source_id and e.id=any(angles.excerpt_ids));
  end if;
  return true;
end; $$;

create or replace function public.reject_content_channel(p_request_id uuid,p_output_id uuid,p_actor_id uuid,p_note text)
returns boolean language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
begin
  perform 1 from profiles where id=p_actor_id and role in ('reviewer','admin');
  if not found then raise exception 'A reviewer must reject content'; end if;
  perform 1 from content_requests where id=p_request_id and status in ('content_review','scheduled') and deleted_at is null for update;
  if not found then raise exception 'This request is not available for review'; end if;
  perform 1 from channel_outputs where id=p_output_id and request_id=p_request_id and status in ('draft','format_failed') for update;
  if not found then raise exception 'This output was already decided. Refresh to see its status'; end if;
  if nullif(trim(p_note),'') is null then raise exception 'Add a reason for rejecting this output'; end if;
  insert into approvals(request_id,subject_type,subject_id,actor_id,decision,note)
    values(p_request_id,'channel_output',p_output_id,p_actor_id,'rejected',left(trim(p_note),4000));
  update channel_outputs set status='rejected' where id=p_output_id;
  return true;
end; $$;

create or replace function public.stop_content_request(p_request_id uuid,p_actor_id uuid,p_delete boolean default false)
returns boolean language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
begin
  perform 1 from content_requests where id=p_request_id and deleted_at is null for update;
  if not found then return false; end if;
  -- Lock queue records too, so a release cannot claim one while it is being cancelled.
  perform 1 from publish_queue where request_id=p_request_id for update;
  if p_delete and exists(select 1 from publish_queue where request_id=p_request_id and status in ('published','posted_manually','partially_delivered','publishing','uncertain')) then
    raise exception 'A request with delivered or unresolved content must keep its audit record';
  end if;
  update publish_queue set status='cancelled' where request_id=p_request_id and status in ('held','queued','blocked_not_connected','failed','awaiting_manual_post');
  update content_requests set
    status=case when p_delete then status else 'cancelled'::request_status end,
    current_step=case when p_delete then current_step else null end,
    runner_lease_id=null,runner_lease_until=null,retry_after=null,
    deleted_at=case when p_delete then now() else null end,
    deleted_by=case when p_delete then p_actor_id else null end where id=p_request_id;
  return true;
end; $$;

-- The final delivery gate also checks the parent request and article snapshot.
create or replace function content_agent.assert_output_approved(p_channel_output_id uuid)
returns boolean language plpgsql stable security definer set search_path=content_agent,public,extensions as $$
begin
  if not exists(select 1 from channel_outputs o join content_requests r on r.id=o.request_id
    where o.id=p_channel_output_id and o.status='approved' and r.deleted_at is null
      and r.status in ('scheduled','publishing','published')
      and o.article_version_id=(select id from article_versions where request_id=r.id order by version desc limit 1)
      and exists(select 1 from approvals a where a.subject_id=o.id and a.subject_type='channel_output' and a.decision='approved')) then
    raise exception 'Content is unapproved, outdated, cancelled or deleted';
  end if;
  return true;
end; $$;

revoke execute on function public.review_content_article(uuid,uuid,text,text),public.set_content_source(uuid,uuid,uuid,boolean,text),
  public.reject_content_channel(uuid,uuid,uuid,text),public.stop_content_request(uuid,uuid,boolean),content_agent.assert_output_approved(uuid)
  from public,anon,authenticated;
grant execute on function public.review_content_article(uuid,uuid,text,text),public.set_content_source(uuid,uuid,uuid,boolean,text),
  public.reject_content_channel(uuid,uuid,uuid,text),public.stop_content_request(uuid,uuid,boolean),content_agent.assert_output_approved(uuid)
  to service_role;
create or replace function public.choose_content_image(p_request_id uuid,p_image_id uuid,p_alt text)
returns boolean language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
begin
  perform 1 from content_requests where id=p_request_id and deleted_at is null and status in ('content_review','needs_human') for update;
  if not found then raise exception 'This article is locked'; end if;
  if p_image_id is not null then
    if nullif(trim(p_alt),'') is null or length(p_alt)>200 then raise exception 'Describe the image in 1 to 200 characters'; end if;
    perform 1 from images where id=p_image_id and request_id=p_request_id and licence is not null;
    if not found then raise exception 'This image is not available'; end if;
  end if;
  update images set chosen=false where request_id=p_request_id;
  if p_image_id is not null then update images set chosen=true,alt_text=trim(p_alt) where id=p_image_id; end if;
  return true;
end; $$;
revoke execute on function public.choose_content_image(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.choose_content_image(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
