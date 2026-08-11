-- P11: materialise case ownership onto the case row.
--
-- Before this migration, `caseHandlerOwners()` derived owners live from public.handlers at
-- read time. That made "handler added -> owns the account's active cases", "handler removed
-- -> keeps the cases already owned" and "closed cases are never modified" all impossible.
--
-- This migration seeds cases.extra_owners with EXACTLY the set the old derivation produced,
-- so behaviour is visibly unchanged on the day it ships. The reference implementation lives
-- in src/server/cases/owner-seed.ts and is unit-tested per case; the DO block below mirrors
-- it and re-verifies every single case before committing, aborting on any mismatch.
--
-- Old derivation, reproduced:
--   handler_owners = handlers for the case's customer, excluding 'direct'
--   if handler_owners is empty: [cases.owner]  (dropped when blank or 'direct')
--   owners = distinct(handler_owners ++ existing extra_owners)
--
-- extra_owners is a pipe-joined text column (' | ' separator on write).

-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single transaction
-- (sql.begin), so this file must NOT issue its own BEGIN/COMMIT - doing so would commit
-- before the schema_migrations bookkeeping row is written. Everything below is atomic.

-- Normalised view of the old derivation, computed once from pre-migration state.
create temporary table _p11_derived on commit drop as
with real_handlers as (
  select
    h.customer_id,
    array_agg(distinct lower(btrim(h.user_email))) as emails
  from public.handlers h
  where lower(btrim(h.user_email)) <> 'direct'
  group by h.customer_id
),
stored_extras as (
  select
    c.case_id,
    coalesce(
      (
        select array_agg(distinct lower(btrim(t)))
        from unnest(string_to_array(coalesce(c.extra_owners, ''), '|')) as t
        where btrim(t) <> ''
      ),
      '{}'::text[]
    ) as emails
  from public.cases c
),
handler_owners as (
  select
    c.case_id,
    case
      when rh.emails is not null and cardinality(rh.emails) > 0 then rh.emails
      when lower(btrim(coalesce(c.owner, ''))) in ('', 'direct') then '{}'::text[]
      else array[lower(btrim(c.owner))]
    end as emails
  from public.cases c
  left join real_handlers rh on rh.customer_id = c.customer_id
)
select
  ho.case_id,
  (
    select coalesce(array_agg(distinct e order by e), '{}'::text[])
    from unnest(ho.emails || se.emails) as e
    where btrim(e) <> ''
  ) as owners
from handler_owners ho
join stored_extras se on se.case_id = ho.case_id;

-- Write the seeded set. array_to_string with ' | ' matches joinPipe() in domain/lists.ts.
update public.cases c
set extra_owners = array_to_string(d.owners, ' | ')
from _p11_derived d
where d.case_id = c.case_id;

-- Per-case verification: recompute the OLD derivation against the ORIGINAL snapshot in
-- _p11_derived and compare it, case by case, with what is now stored. Any single mismatch
-- aborts the whole migration.
do $$
declare
  mismatch_id text;
  mismatch_expected text;
  mismatch_actual text;
  mismatch_count integer;
begin
  select count(*)
  into mismatch_count
  from _p11_derived d
  join public.cases c on c.case_id = d.case_id
  where d.owners is distinct from (
    select coalesce(array_agg(distinct lower(btrim(t)) order by lower(btrim(t))), '{}'::text[])
    from unnest(string_to_array(coalesce(c.extra_owners, ''), '|')) as t
    where btrim(t) <> ''
  );

  if mismatch_count > 0 then
    select d.case_id,
           array_to_string(d.owners, ' | '),
           c.extra_owners
    into mismatch_id, mismatch_expected, mismatch_actual
    from _p11_derived d
    join public.cases c on c.case_id = d.case_id
    where d.owners is distinct from (
      select coalesce(array_agg(distinct lower(btrim(t)) order by lower(btrim(t))), '{}'::text[])
      from unnest(string_to_array(coalesce(c.extra_owners, ''), '|')) as t
      where btrim(t) <> ''
    )
    limit 1;

    raise exception
      'P11 seed aborted: % case(s) do not match the old derivation. First: % expected [%] but stored [%]',
      mismatch_count, mismatch_id, mismatch_expected, mismatch_actual;
  end if;

  raise notice 'P11 seed verified for % case(s).', (select count(*) from _p11_derived);
end
$$;
