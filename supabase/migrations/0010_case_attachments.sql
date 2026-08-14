-- Attachments on a ticket handover response. Files live in Google Drive; only
-- metadata is stored here.
--
-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single
-- transaction (sql.begin), so this file must NOT issue its own BEGIN/COMMIT.

set local lock_timeout = '3s';

create table if not exists public.case_attachments (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activity_log(id) on delete cascade,
  case_id text not null,
  drive_file_id text not null,
  drive_view_link text not null default '',
  file_name text not null default '',
  mime_type text not null default '',
  size_bytes bigint not null default 0,
  uploaded_by text references public.users(email),
  created_at timestamptz not null default now()
);

create index if not exists case_attachments_activity_id_idx on public.case_attachments(activity_id);
create index if not exists case_attachments_case_id_idx on public.case_attachments(case_id);

alter table public.case_attachments enable row level security;
revoke all on table public.case_attachments from anon, authenticated;

drop policy if exists deny_direct_select on public.case_attachments;
drop policy if exists deny_direct_insert on public.case_attachments;
drop policy if exists deny_direct_update on public.case_attachments;
drop policy if exists deny_direct_delete on public.case_attachments;

create policy deny_direct_select on public.case_attachments for select to anon, authenticated using (false);
create policy deny_direct_insert on public.case_attachments for insert to anon, authenticated with check (false);
create policy deny_direct_update on public.case_attachments for update to anon, authenticated using (false) with check (false);
create policy deny_direct_delete on public.case_attachments for delete to anon, authenticated using (false);

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'case_attachments'
  ) then
    raise exception 'case_attachments was not created';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'case_attachments' and column_name = 'activity_id'
  ) then
    raise exception 'case_attachments.activity_id is missing';
  end if;
end $$;
