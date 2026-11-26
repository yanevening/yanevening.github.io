begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'student' check (role in ('student', 'admin')),
  enabled boolean not null default true
);
alter table public.account_profiles enable row level security;
revoke all on public.account_profiles from public, anon, authenticated;
grant select on public.account_profiles to authenticated;
create policy own_profile on public.account_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

insert into public.account_profiles(user_id) select id from auth.users;
-- Bootstrap only an unambiguous single existing account.
update public.account_profiles set role = 'admin'
  where (select count(*) from public.account_profiles) = 1;

create function private.create_account_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.account_profiles(user_id) values (new.id);
  return new;
end;
$$;
revoke all on function private.create_account_profile() from public, anon, authenticated;
create trigger create_practice_account after insert on auth.users
  for each row execute function private.create_account_profile();

create function private.account_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.account_profiles where user_id = auth.uid() and enabled);
$$;
revoke all on function private.account_active() from public, anon, authenticated;
grant execute on function private.account_active() to authenticated;

create policy active_account on public.practice_records as restrictive
  for all to authenticated using ((select private.account_active()))
  with check ((select private.account_active()));

create function private.require_admin() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.account_profiles
    where user_id = auth.uid() and enabled and role = 'admin') then
    raise exception 'Administrator required' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_admin() from public, anon, authenticated;

create function public.list_practice_accounts()
returns table(user_id uuid, email text, role text, enabled boolean)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query select p.user_id, u.email::text, p.role, p.enabled
    from public.account_profiles p join auth.users u on u.id = p.user_id
    order by u.created_at, p.user_id;
end;
$$;

create or replace function public.set_practice_account(target_user uuid, new_role text, new_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  lock table public.account_profiles in share row exclusive mode;
  perform private.require_admin();
  if target_user = auth.uid() then
    raise exception 'Cannot change your own role or status' using errcode = '42501';
  end if;
  if new_role is null or new_role not in ('student', 'admin') or new_enabled is null then
    raise exception 'Invalid role or status' using errcode = '22023';
  end if;
  update public.account_profiles set role = new_role, enabled = new_enabled where user_id = target_user;
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.list_practice_accounts() from public, anon, authenticated;
revoke all on function public.set_practice_account(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.list_practice_accounts() to authenticated;
grant execute on function public.set_practice_account(uuid,text,boolean) to authenticated;
commit;
