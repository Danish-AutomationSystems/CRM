-- P1: L5/L6 users may not be account handlers.
--
-- ORDERING CONSTRAINT - this migration MUST run after 0005_materialise_case_owners.sql.
-- Under the old derive-at-read-time model, deleting a handler row silently stripped that
-- person from every case on the account, INCLUDING closed ones, with no way to recover it.
-- Now that 0005 has materialised ownership onto cases.extra_owners, deleting the handler row
-- is inert: every case keeps the owners it already had. This file therefore never writes to
-- public.cases at all, and a test asserts that it doesn't.
--
-- The application-level guard lives in customers/service.ts::addHandler.

-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single transaction
-- (sql.begin), so this file must NOT issue its own BEGIN/COMMIT - doing so would commit
-- before the schema_migrations bookkeeping row is written. Everything below is atomic.

do $$
declare
  before_count integer;
  after_count integer;
  cases_with_owner_before integer;
  cases_with_owner_after integer;
begin
  select count(*)
  into before_count
  from public.handlers h
  join public.users u on u.email = h.user_email
  where u.role in ('L5', 'L6');

  -- Number of cases that currently have at least one materialised owner.
  select count(*)
  into cases_with_owner_before
  from public.cases c
  where btrim(coalesce(c.extra_owners, '')) <> '';

  delete from public.handlers h
  using public.users u
  where u.email = h.user_email
    and u.role in ('L5', 'L6');

  select count(*)
  into after_count
  from public.handlers h
  join public.users u on u.email = h.user_email
  where u.role in ('L5', 'L6');

  select count(*)
  into cases_with_owner_after
  from public.cases c
  where btrim(coalesce(c.extra_owners, '')) <> '';

  if after_count <> 0 then
    raise exception 'P1 cleanup failed: % L5/L6 handler row(s) remain.', after_count;
  end if;

  -- The whole point of the 0005 dependency: no case may lose an owner here.
  if cases_with_owner_after <> cases_with_owner_before then
    raise exception
      'P1 cleanup aborted: owned-case count changed from % to %. Ownership was not materialised.',
      cases_with_owner_before, cases_with_owner_after;
  end if;

  raise notice 'P1 cleanup removed % L5/L6 handler row(s); % owned case(s) unchanged.',
    before_count, cases_with_owner_after;
end
$$;
