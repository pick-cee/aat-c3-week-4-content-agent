-- A review decision, output state and queue entry either all commit or none do.
create or replace function public.approve_content_channel(
  p_request_id uuid, p_output_id uuid, p_actor_id uuid,
  p_scheduled_for timestamptz default null, p_note text default null
) returns setof content_agent.publish_queue
language plpgsql volatile security definer set search_path = content_agent, public, extensions as $$
declare req content_requests; output channel_outputs; latest_id uuid; send_at timestamptz;
begin
  perform 1 from profiles where id = p_actor_id and role in ('reviewer','admin');
  if not found then raise exception 'Only a reviewer can approve content'; end if;
  select * into req from content_requests where id = p_request_id and deleted_at is null for update;
  if not found or req.status not in ('content_review','scheduled') then
    raise exception 'This request is not ready for approval';
  end if;
  select * into output from channel_outputs where id = p_output_id and request_id = p_request_id for update;
  if not found then raise exception 'Channel output not found'; end if;
  select id into latest_id from article_versions where request_id = p_request_id order by version desc limit 1;
  if output.article_version_id <> latest_id then raise exception 'This output belongs to an older article. Review the latest version'; end if;
  if exists(select 1 from channel_outputs where request_id = p_request_id and channel = output.channel and version > output.version) then
    raise exception 'A newer channel version is available';
  end if;
  if output.status = 'format_failed' and nullif(trim(p_note),'') is null then raise exception 'Explain why the failed format check is being overridden'; end if;
  if not exists(select 1 from evaluations where article_version_id = latest_id and status = 'pass')
    and not exists(select 1 from approvals where subject_type = 'article' and subject_id = latest_id and decision = 'approved' and nullif(trim(note),'') is not null) then
    raise exception 'The article needs a passing evaluation or an explicit reviewer override';
  end if;
  if output.status = 'approved' then
    return query select * from publish_queue where channel_output_id = p_output_id and status <> 'cancelled';
    return;
  end if;
  if output.status = 'rejected' then raise exception 'A rejected output cannot be approved'; end if;
  send_at := coalesce(p_scheduled_for, req.publish_target, case when not req.hold_in_queue then now() end);
  insert into approvals(request_id, subject_type, subject_id, actor_id, decision, note)
    values(p_request_id,'channel_output',p_output_id,p_actor_id,'approved',p_note);
  update channel_outputs set status = 'approved' where id = p_output_id;
  update content_requests set status = 'scheduled', current_step = null where id = p_request_id;
  return query insert into publish_queue(request_id,channel_output_id,channel,kind,scheduled_for,status,approved_by,approved_at,idempotency_key)
    values(p_request_id,p_output_id,output.channel,
      coalesce((select kind from connectors where channel = output.channel),case when output.channel = 'newsletter' then 'delivering'::connector_kind else 'handoff'::connector_kind end),
      send_at,case when send_at is null then 'held'::publish_status else 'queued'::publish_status end,
      p_actor_id,now(),p_output_id::text || ':' || output.channel::text) returning *;
end;
$$;

create or replace function public.save_content_edit(p_request_id uuid, p_parent_id uuid, p_body text, p_title text, p_headings jsonb, p_word_count int)
returns uuid language plpgsql volatile security definer set search_path = content_agent, public, extensions as $$
declare req content_requests; parent article_versions; new_id uuid;
begin
  select * into req from content_requests where id = p_request_id and deleted_at is null for update;
  if not found or req.status not in ('content_review','needs_human') then raise exception 'This article is locked for editing'; end if;
  select * into parent from article_versions where request_id = p_request_id order by version desc limit 1;
  if parent.id is null or parent.id <> p_parent_id then raise exception 'The article changed. Refresh before saving'; end if;
  if exists(select 1 from channel_outputs where request_id = p_request_id and status = 'approved') then
    raise exception 'Approved content cannot be edited';
  end if;
  insert into article_versions(request_id,version,angle_id,title,meta_description,body_md,primary_keyword,
    secondary_keywords,word_count,headings,claim_map,link_targets,excerpt_ids_used,origin,parent_version_id)
    values(p_request_id,parent.version+1,parent.angle_id,p_title,parent.meta_description,p_body,parent.primary_keyword,
      parent.secondary_keywords,p_word_count,p_headings,'[]'::jsonb,
      parent.link_targets,parent.excerpt_ids_used,'human_edit',parent.id) returning id into new_id;
  update content_requests set status = 'evaluating',current_step = 'evaluate',step_attempts=0,revision_rounds=0,
    failure_reason=null,failure_detail=null,retry_after=null where id=p_request_id;
  return new_id;
end;
$$;
revoke execute on function public.approve_content_channel(uuid,uuid,uuid,timestamptz,text),
  public.save_content_edit(uuid,uuid,text,text,jsonb,int) from public,anon,authenticated;
grant execute on function public.approve_content_channel(uuid,uuid,uuid,timestamptz,text),
  public.save_content_edit(uuid,uuid,text,text,jsonb,int) to service_role;
notify pgrst, 'reload schema';
