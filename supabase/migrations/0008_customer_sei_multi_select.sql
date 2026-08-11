-- P8: customers.sei becomes a multi-select (text -> text[]).
--
-- Existing free-text values are SPLIT and PRESERVED, never dropped. The split rule is
-- '\s*[|,]\s*' plus removal of blanks, mirrored exactly by parseSeiText() in
-- src/server/customers/sei.ts, which is unit-tested row-shape by row-shape.
--
-- public.recycle_bin.sei is converted too: restoreCustomer() copies that column straight back
-- into public.customers, so leaving it as text would break every restore.
--
-- The selectable names live in public.settings under SEI_NAMES and are read LIVE by the app.
-- This migration seeds that key EMPTY - no invented names. An L6 populates it in Admin.

-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single transaction
-- (sql.begin), so this file must NOT issue its own BEGIN/COMMIT - doing so would commit
-- before the schema_migrations bookkeeping row is written. Everything below is atomic.

-- Snapshot the pre-conversion values so the result can be verified per row.
create temporary table _p8_sei_before on commit drop as
select
  customer_id,
  sei as sei_text,
  (
    select coalesce(array_agg(btrim(t) order by ord), '{}'::text[])
    from unnest(regexp_split_to_array(coalesce(sei, ''), '\s*[|,]\s*')) with ordinality as u(t, ord)
    where btrim(t) <> ''
  ) as expected
from public.customers;

-- customers_sei_idx is a btree on the old text column; it must go before the type change.
drop index if exists public.customers_sei_idx;

alter table public.customers
  alter column sei drop default;

alter table public.customers
  alter column sei type text[]
  using (
    case
      when btrim(coalesce(sei, '')) = '' then '{}'::text[]
      else (
        select coalesce(array_agg(btrim(t) order by ord), '{}'::text[])
        from unnest(regexp_split_to_array(sei, '\s*[|,]\s*')) with ordinality as u(t, ord)
        where btrim(t) <> ''
      )
    end
  );

alter table public.customers
  alter column sei set default '{}'::text[];

alter table public.recycle_bin
  alter column sei drop default;

alter table public.recycle_bin
  alter column sei type text[]
  using (
    case
      when btrim(coalesce(sei, '')) = '' then '{}'::text[]
      else (
        select coalesce(array_agg(btrim(t) order by ord), '{}'::text[])
        from unnest(regexp_split_to_array(sei, '\s*[|,]\s*')) with ordinality as u(t, ord)
        where btrim(t) <> ''
      )
    end
  );

alter table public.recycle_bin
  alter column sei set default '{}'::text[];

-- GIN suits containment lookups on the new array column.
create index if not exists customers_sei_idx on public.customers using gin (sei);

-- P8: the admin-managed name list. Ships EMPTY on purpose.
insert into public.settings (key, value)
values ('SEI_NAMES', '')
on conflict (key) do nothing;

do $$
declare
  mismatch_count integer;
  mismatch_id text;
  lost_count integer;
begin
  -- Per-row equivalence: the converted array must equal the expected split of the original
  -- text, for every customer.
  select count(*)
  into mismatch_count
  from _p8_sei_before b
  join public.customers c on c.customer_id = b.customer_id
  where c.sei is distinct from b.expected;

  if mismatch_count > 0 then
    select b.customer_id into mismatch_id
    from _p8_sei_before b
    join public.customers c on c.customer_id = b.customer_id
    where c.sei is distinct from b.expected
    limit 1;

    raise exception 'P8 conversion aborted: % row(s) mismatch. First: %.', mismatch_count, mismatch_id;
  end if;

  -- No row that had a non-blank value may have ended up empty.
  select count(*)
  into lost_count
  from _p8_sei_before b
  join public.customers c on c.customer_id = b.customer_id
  where btrim(coalesce(b.sei_text, '')) <> ''
    and cardinality(coalesce(c.sei, '{}')) = 0;

  if lost_count > 0 then
    raise exception 'P8 conversion aborted: % customer(s) lost their SEI value.', lost_count;
  end if;

  if not exists (select 1 from public.settings where key = 'SEI_NAMES') then
    raise exception 'P8 failed: SEI_NAMES settings row was not created.';
  end if;

  raise notice 'P8 SEI conversion verified; % customer(s) carry at least one SEI value.',
    (select count(*) from public.customers where cardinality(coalesce(sei, '{}')) > 0);
end
$$;
