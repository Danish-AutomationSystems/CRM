-- Case ownership is no longer stored on the case. A case's owners are its account's handlers,
-- derived live (src/server/auth/access.ts caseHandlers), with the case creator (created_by) as
-- the fallback when the account has no real handler. The two columns that materialised
-- case-level ownership, and the index on one of them, are removed.
--
-- Backups taken before this migration still carry owner/extra_owners on public.cases rows.
-- scripts/restore-database.mjs inserts every key it finds, so strip those two keys before
-- restoring such a backup into a post-0014 schema.
--
-- scripts/apply-migrations.mjs wraps each file in a single transaction; do not BEGIN/COMMIT here.

set local lock_timeout = '3s';

drop index if exists public.cases_owner_outcome_idx;
alter table public.cases drop column if exists owner;
alter table public.cases drop column if exists extra_owners;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cases' and column_name in ('owner', 'extra_owners')
  ) then
    raise exception 'public.cases.owner and extra_owners must be gone after this migration';
  end if;

  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'cases_owner_outcome_idx') then
    raise exception 'cases_owner_outcome_idx must be gone after this migration';
  end if;
end $$;
