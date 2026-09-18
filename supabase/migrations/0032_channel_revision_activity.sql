-- Revision audit events commit with the request/output, including on worker retries.
-- Free-text notes stay in their original records and are redacted for display by
-- the application, rather than copied into the diagnostic activity log.
create or replace function content_agent.record_channel_revision_activity(p_approval_id uuid, p_output_id uuid)
returns void language plpgsql security definer set search_path=content_agent,public as $$
begin
  insert into activity_log(request_id,step,message,detail,actor_id,created_at)
  select a.request_id,'adapt',
    (case o.channel when 'newsletter' then 'Newsletter' when 'linkedin' then 'LinkedIn' else 'X' end) || ' revision requested.',
    jsonb_build_object('event','channel_revision_requested','approval_id',a.id,'output_id',o.id,'channel',o.channel,'version',o.version),
    a.actor_id,a.created_at
  from approvals a join channel_outputs o on o.id=a.subject_id and o.request_id=a.request_id
  where a.id=p_approval_id and a.subject_type='channel_output' and a.decision='revision_requested'
    and not exists(select 1 from activity_log l where l.request_id=a.request_id
      and l.detail->>'event'='channel_revision_requested' and l.detail->>'approval_id'=a.id::text);

  insert into activity_log(request_id,step,level,message,detail,created_at)
  select o.request_id,'adapt',
    (case when not coalesce((o.format_check->>'passed')::boolean,false) then 'warn' else 'info' end)::log_level,
    (case o.channel when 'newsletter' then 'Newsletter' when 'linkedin' then 'LinkedIn' else 'X' end)
      || ' revision saved as version ' || o.version || '. '
      || case when not coalesce((o.format_check->>'passed')::boolean,false)
        then 'Format checks need attention before approval.' else 'Ready for fresh approval.' end,
    jsonb_build_object('event','channel_revision_completed','output_id',o.id,'channel',o.channel,
      'version',o.version,'article_version_id',o.article_version_id,'revision_job_id',o.revision_job_id),o.created_at
  from channel_outputs o
  where o.id=p_output_id and o.revision_job_id is not null
    and not exists(select 1 from activity_log l where l.request_id=o.request_id
      and l.detail->>'event'='channel_revision_completed' and l.detail->>'output_id'=o.id::text);
end; $$;

create or replace function content_agent.log_channel_revision_insert()
returns trigger language plpgsql security definer set search_path=content_agent,public as $$
begin
  if TG_TABLE_NAME='approvals' then
    perform record_channel_revision_activity(new.id,null);
  else
    perform record_channel_revision_activity(null,new.id);
  end if;
  return new;
end; $$;

revoke all on function content_agent.record_channel_revision_activity(uuid,uuid) from public,anon,authenticated;
revoke all on function content_agent.log_channel_revision_insert() from public,anon,authenticated;

drop trigger if exists channel_revision_requested_activity on content_agent.approvals;
create trigger channel_revision_requested_activity after insert on content_agent.approvals
for each row when (new.subject_type='channel_output' and new.decision='revision_requested')
execute function content_agent.log_channel_revision_insert();

drop trigger if exists channel_revision_completed_activity on content_agent.channel_outputs;
create trigger channel_revision_completed_activity after insert on content_agent.channel_outputs
for each row when (new.revision_job_id is not null)
execute function content_agent.log_channel_revision_insert();

-- Restore missing history with the original event timestamps. Safe to rerun.
do $$
declare event record;
begin
  for event in select id from content_agent.approvals where subject_type='channel_output' and decision='revision_requested'
  loop perform content_agent.record_channel_revision_activity(event.id,null); end loop;
  for event in select id from content_agent.channel_outputs where revision_job_id is not null
  loop perform content_agent.record_channel_revision_activity(null,event.id); end loop;
end; $$;
