-- Optional case priority: High / Medium / Low, or '' for "not set".
--
-- `not null default ''` mirrors public.customers.priority (0001_initial_schema.sql:24),
-- which has carried exactly this shape since the initial schema. Empty string rather
-- than NULL keeps every read path free of null-handling, and priChip('') already
-- renders nothing, so existing cases look identical after this ships.
--
-- Deliberately NO check constraint on the values. customers.priority has none, for a
-- reason: an L6 admin can edit the PRIORITIES list in Admin -> Settings, and a database
-- constraint would start rejecting saves that the UI itself offers. Validation is
-- server-side, via validOne(input, DEFAULT_SETTINGS.PRIORITIES).
--
-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single transaction
-- (sql.begin), so this file must NOT issue its own BEGIN/COMMIT - doing so would commit
-- before the schema_migrations bookkeeping row is written. Everything below is atomic.

-- Fail fast rather than queueing for the ACCESS EXCLUSIVE lock behind a long read.
-- public.cases is read by the case list, the case page, and every dashboard; all of
-- them would block behind us while we waited.
set local lock_timeout = '3s';

alter table public.cases
  add column if not exists priority text not null default '';

-- No index here: the Cases-tab priority filter is applied in JavaScript, in
-- listCases (src/server/cases/service.ts), not via a SQL predicate. An index
-- should be added by whichever later migration pushes that filtering into SQL -
-- an index nothing reads is cost without benefit.

do $$
declare
  col_type text;
  col_nullable text;
  col_default text;
begin
  select data_type, is_nullable, column_default
    into col_type, col_nullable, col_default
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'cases'
     and column_name = 'priority';

  if col_type is null then
    raise exception 'cases.priority was not created';
  end if;

  if col_type <> 'text' then
    raise exception 'cases.priority has type %, expected text', col_type;
  end if;

  if col_nullable <> 'NO' then
    raise exception 'cases.priority must be NOT NULL';
  end if;

  if col_default is null or col_default not like '''''%' then
    raise exception 'cases.priority default is %, expected the empty string', col_default;
  end if;

  -- Deliberately no row-level probe here. The column is NOT NULL two statements up,
  -- so any `where priority is null` predicate can never be true - and because it can
  -- never be true, Postgres would still seq-scan public.cases to prove it, inside this
  -- transaction, holding ACCESS EXCLUSIVE and blocking every reader. Without it,
  -- `add column ... not null default ''` is metadata-only on PG 11+.
end $$;
