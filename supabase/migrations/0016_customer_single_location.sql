-- P7 follow-up: multiple locations may be given to a user, never to a customer - a
-- customer holds exactly one location tag. The service layer (src/server/customers/
-- service.ts requiredTags) now rejects zero or two-or-more locations on both create
-- and update, but this constraint is the backstop for anything that bypasses the
-- service layer.
--
-- Verified before writing this migration: no customer in the database currently
-- holds more than one tag, so no data migration is needed here - validation only.
--
-- scripts/apply-migrations.mjs wraps each file in a single transaction; do not BEGIN/COMMIT here.

set local lock_timeout = '3s';

alter table public.customers
  add constraint customers_single_location_check
  check (cardinality(tags) = 1);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_single_location_check'
      and conrelid = 'public.customers'::regclass
  ) then
    raise exception 'customers_single_location_check must exist on public.customers after this migration';
  end if;
end $$;
