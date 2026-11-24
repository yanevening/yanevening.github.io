begin;

create table public.practice_records (
  user_id uuid not null references auth.users (id) on delete cascade,
  record_key text not null check (record_key ~ '^(answer|draft):[0-9]{1,32}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  edited_at timestamptz not null,
  primary key (user_id, record_key)
);

alter table public.practice_records enable row level security;
revoke all on public.practice_records from public, anon, authenticated;
grant select, insert, update on public.practice_records to authenticated;

create policy read_own_records on public.practice_records
  for select to authenticated using ((select auth.uid()) = user_id);
create policy insert_own_records on public.practice_records
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy update_own_records on public.practice_records
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create function public.merge_practice_records(records jsonb, expected_user uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() <> expected_user or expected_user is null then
    raise exception 'Practice account changed' using errcode = '42501';
  end if;

  insert into public.practice_records as saved (user_id, record_key, payload, edited_at)
  select expected_user, incoming.record_key, incoming.payload, incoming.edited_at
  from pg_catalog.jsonb_to_recordset(records) as incoming(
    record_key text, payload jsonb, edited_at timestamptz, import_only boolean
  )
  where incoming.import_only is not true
  order by incoming.record_key
  on conflict (user_id, record_key) do update
    set payload = excluded.payload, edited_at = excluded.edited_at
    where excluded.edited_at > saved.edited_at;

  insert into public.practice_records (user_id, record_key, payload, edited_at)
  select expected_user, incoming.record_key, incoming.payload, incoming.edited_at
  from pg_catalog.jsonb_to_recordset(records) as incoming(
    record_key text, payload jsonb, edited_at timestamptz, import_only boolean
  )
  where incoming.import_only is true
  order by incoming.record_key
  on conflict (user_id, record_key) do nothing;
end;
$$;

revoke all on function public.merge_practice_records(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.merge_practice_records(jsonb, uuid) to authenticated;

commit;
