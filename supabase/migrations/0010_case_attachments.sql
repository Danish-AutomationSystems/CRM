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

-- One row per Drive file, enforced by the database.
--
-- The service refuses a file id that is already attached, but that is a read
-- taken outside the transaction: two concurrent reassignments reporting the
-- same file id can both pass it and both insert. This index makes the second
-- one fail instead. It also keeps a single Drive file from being claimed by two
-- different handovers, which would make cleanup on rollback destructive.
create unique index if not exists case_attachments_drive_file_id_key on public.case_attachments(drive_file_id);

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

  -- The uniqueness of drive_file_id is a correctness guarantee the service
  -- relies on, not an optimisation: without it two concurrent reassignments can
  -- attach the same Drive file twice.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'case_attachments'
       and indexname = 'case_attachments_drive_file_id_key'
  ) then
    raise exception 'case_attachments_drive_file_id_key is missing';
  end if;
end $$;
