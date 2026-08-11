-- P7: location (customers.tags) becomes mandatory.
--
-- Existing rows with no location would otherwise be un-savable once createCustomer /
-- updateCustomer start requiring one. They are backfilled with the placeholder
-- 'TO BE FILLED', which is a RECOGNISED location value (see DEFAULT_SETTINGS.TAGS in
-- src/server/settings/defaults.ts) but is deliberately excluded from SELECTABLE_TAGS, so no
-- one can pick it deliberately and a later save cannot silently strip it.
--
-- Nothing is deleted and no row is created: only empty `tags` arrays are filled.

-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single transaction
-- (sql.begin), so this file must NOT issue its own BEGIN/COMMIT - doing so would commit
-- before the schema_migrations bookkeeping row is written. Everything below is atomic.

do $$
declare
  empty_before integer;
  empty_after integer;
  total_before integer;
  total_after integer;
begin
  select count(*) into total_before from public.customers;
  select count(*) into empty_before from public.customers where cardinality(coalesce(tags, '{}')) = 0;

  update public.customers
  set tags = array['TO BE FILLED']
  where cardinality(coalesce(tags, '{}')) = 0;

  select count(*) into total_after from public.customers;
  select count(*) into empty_after from public.customers where cardinality(coalesce(tags, '{}')) = 0;

  if empty_after <> 0 then
    raise exception 'P7 backfill failed: % customer(s) still have no location.', empty_after;
  end if;

  if total_after <> total_before then
    raise exception 'P7 backfill aborted: customer count changed from % to %.', total_before, total_after;
  end if;

  raise notice 'P7 backfill filled % of % customer(s); total unchanged.', empty_before, total_after;
end
$$;
