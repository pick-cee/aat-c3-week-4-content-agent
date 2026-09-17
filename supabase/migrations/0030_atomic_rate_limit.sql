-- Consume an allowance in the same statement that checks it. Failed sign-ins
-- count too; simultaneous requests cannot all pass a read-then-increment gate.
create or replace function public.consume_rate_limit(p_scope text,p_scope_key text,p_window text,p_metric text,p_limit int)
returns jsonb language plpgsql volatile security definer set search_path=content_agent,public,extensions as $$
declare used int;
begin
  if p_limit < 1 or p_window not in ('minute','hour','day','month') or p_scope not in ('profile','ip','global') then
    raise exception 'Invalid rate limit configuration';
  end if;
  insert into usage_counters(scope,scope_key,window_size,window_start,metric,count,cents)
    values(p_scope,p_scope_key,p_window,date_trunc(p_window,now()),p_metric,1,0)
  on conflict(scope,scope_key,window_size,window_start,metric)
    do update set count=usage_counters.count+1 where usage_counters.count < p_limit
  returning count into used;
  return jsonb_build_object('allowed',used is not null,'current',coalesce(used,p_limit));
end; $$;
revoke execute on function public.consume_rate_limit(text,text,text,text,int) from public,anon,authenticated;
grant execute on function public.consume_rate_limit(text,text,text,text,int) to service_role;
