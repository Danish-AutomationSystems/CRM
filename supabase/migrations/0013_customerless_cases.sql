-- Leads and opportunities can precede customer identification. Keep the existing FK.
--
-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single transaction
-- (sql.begin), so this file must NOT issue its own BEGIN/COMMIT - doing so would commit
-- before the schema_migrations bookkeeping row is written. Everything below is atomic.

-- Fail fast rather than queueing for the ACCESS EXCLUSIVE lock behind a long read.
-- public.cases is read by the case list, the case page, and every dashboard; all of
-- them would block behind us while we waited.
set local lock_timeout = '3s';

alter table public.cases alter column customer_id drop not null;
alter table public.cases add constraint cases_quoted_customer_check
  check ((stage <> 'Quoted' and outcome is distinct from 'Won') or customer_id is not null);

do $$
declare
  col_nullable text;
  constraint_exists boolean;
begin
  select is_nullable into col_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'cases'
     and column_name = 'customer_id';

  if col_nullable <> 'YES' then
    raise exception 'public.cases.customer_id must be nullable after this migration';
  end if;

  select exists(
    select 1 from pg_constraint
     where conrelid = 'public.cases'::regclass
       and conname = 'cases_quoted_customer_check'
  ) into constraint_exists;

  if not constraint_exists then
    raise exception 'cases_quoted_customer_check was not created';
  end if;
end $$;
