-- Ticket handover notes: an optional internal note attached to a reassignment.
--
-- `not null default ''` rather than nullable, so the three logActivity
-- implementations that do NOT write this column (customers, quotes, admin)
-- keep working untouched. Only src/server/cases/repository.ts writes it.
--
-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single
-- transaction (sql.begin), so this file must NOT issue its own BEGIN/COMMIT -
-- doing so would commit before the schema_migrations bookkeeping row is
-- written. Everything below is atomic.

-- Fail fast rather than queueing for the ACCESS EXCLUSIVE lock behind a long
-- read: every logActivity in the system (cases, customers, quotes, admin)
-- would block behind us while we waited.
set local lock_timeout = '3s';

alter table public.activity_log
  add column if not exists note text not null default '';

do $$
declare
  col_type text;
  col_nullable text;
begin
  select data_type, is_nullable
    into col_type, col_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'activity_log'
     and column_name = 'note';

  if col_type is null then
    raise exception 'activity_log.note was not created';
  end if;

  if col_type <> 'text' then
    raise exception 'activity_log.note has type %, expected text', col_type;
  end if;

  if col_nullable <> 'NO' then
    raise exception 'activity_log.note must be NOT NULL';
  end if;

  -- Deliberately no `where note is null` probe here: the column is NOT NULL
  -- three statements up, so the predicate can never be true, and because it
  -- can never be true Postgres would still seq-scan the largest table to
  -- prove it - inside this transaction, holding ACCESS EXCLUSIVE on
  -- activity_log and blocking every writer. Without it,
  -- `add column ... not null default ''` is metadata-only on PG 11+.
end $$;
