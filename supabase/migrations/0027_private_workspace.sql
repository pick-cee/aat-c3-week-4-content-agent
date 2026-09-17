-- Public pages use server-side projections of an approved version. Direct
-- anonymous table reads otherwise expose briefs, costs and source markdown.
drop policy if exists content_requests_public on content_agent.content_requests;
drop policy if exists article_versions_public on content_agent.article_versions;
drop policy if exists sources_public on content_agent.sources;
drop policy if exists images_public on content_agent.images;
drop policy if exists profiles_update_self on content_agent.profiles;

-- An auth account without membership in this application is not an agency user.
create or replace function content_agent.is_signed_in()
returns boolean language sql stable security definer
set search_path = content_agent, public, extensions as $$
  select exists(select 1 from profiles where id = auth.uid() and not is_demo);
$$;
-- Public demo credentials must never provide direct API access to agency data.
-- The explicitly enabled demo UI uses authenticated server actions instead.
create or replace function content_agent.current_role_is(required content_agent.user_role)
returns boolean language sql stable security definer set search_path=content_agent,public,extensions as $$
  select exists(select 1 from profiles where id=auth.uid() and role=required and not is_demo);
$$;
create or replace function content_agent.can_approve()
returns boolean language sql stable security definer set search_path=content_agent,public,extensions as $$
  select exists(select 1 from profiles where id=auth.uid() and role in ('reviewer','admin') and not is_demo);
$$;
revoke execute on function public.dashboard_counts(), public.read_counter(text,text,text,text) from authenticated;
revoke execute on function content_agent.is_signed_in() from public;
grant execute on function content_agent.is_signed_in() to anon,authenticated,service_role;
notify pgrst, 'reload schema';
