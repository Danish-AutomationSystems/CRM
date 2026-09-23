-- A case can no longer exist without a customer (ownership rules P2). Every creation path
-- already refuses an empty customer; this removes the one remaining customerless case
-- (CASE-2026-0012, a test row with no quotations, actions or attachments) and restores
-- NOT NULL so the database enforces the rule for anything that bypasses the services.
--
-- who is null: activity_log.who references public.users(email) and no migration user exists.
--
-- scripts/apply-migrations.mjs wraps each file in a single transaction; do not BEGIN/COMMIT here.

set local lock_timeout = '3s';

insert into public.activity_log (who, action, entity, customer_id, details)
select null, 'CASE_DELETE', case_id, null, 'Customerless case removed by migration 0018: ' || title
from public.cases
where customer_id is null;

delete from public.cases where customer_id is null;

alter table public.cases alter column customer_id set not null;

do $$
declare
  col_nullable text;
begin
  select is_nullable into col_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'cases'
     and column_name = 'customer_id';

  if col_nullable <> 'NO' then
    raise exception 'public.cases.customer_id must be NOT NULL after this migration';
  end if;
end $$;
