-- Task 2 follow-up: remove the '*' wildcard from users.allowed_tags. The owner:
-- "first of all remove option of all*". '*' used to mean "every location"; grants
-- must now be explicit named lists (see src/server/auth/access.ts tagMatches and
-- src/server/admin/service.ts normalizeAllowedTags, both already updated in the
-- application layer to stop treating '*' as special).
--
-- Exactly two accounts hold '*' today (verified against the live database before
-- writing this migration):
--   - danish@automationsystems.org (L4) -> '{}'. Provably no functional change:
--     accessLevel() (src/server/auth/access.ts) returns FULL for L4+ before tags
--     are ever consulted, so this account's tags are already irrelevant.
--   - testing@automationsystems.org (L2) -> the explicit list of every location in
--     settings.TAGS, EXCLUDING the 'TO BE FILLED' backfill placeholder (see
--     0007_backfill_customer_locations.sql), preserving exactly today's reach.
--     Derived from the settings row itself, not hard-coded, so it cannot drift.
--
-- Order matters: the data migration must run BEFORE the new constraint is added,
-- or the constraint would fail against the still-wildcarded rows.
--
-- scripts/apply-migrations.mjs wraps each file in a single transaction; do not BEGIN/COMMIT here.

set local lock_timeout = '3s';

do $$
declare
  tags_value text;
  location_list text[];
begin
  select value into tags_value from public.settings where key = 'TAGS';
  if tags_value is null then
    raise exception 'settings.TAGS row is missing; cannot derive testing@automationsystems.org''s location list.';
  end if;

  -- settings.TAGS is stored ' | '-joined (see settings/live.ts parsePipe); split on '|',
  -- trim, drop empties, and drop 'TO BE FILLED' - the location-backfill placeholder that
  -- is a recognised value but was never something a wildcard grant meaningfully reached.
  select array_agg(btrim(part))
  into location_list
  from unnest(string_to_array(tags_value, '|')) as part
  where btrim(part) <> '' and btrim(part) <> 'TO BE FILLED';

  if location_list is null or cardinality(location_list) = 0 then
    raise exception 'Derived an empty location list from settings.TAGS (%); refusing to migrate testing@automationsystems.org.', tags_value;
  end if;

  update public.users
  set allowed_tags = '{}'
  where email = 'danish@automationsystems.org';

  update public.users
  set allowed_tags = location_list
  where email = 'testing@automationsystems.org';

  raise notice 'Migrated allowed_tags for danish@automationsystems.org (-> {}) and testing@automationsystems.org (-> %).', location_list;
end
$$;

-- Post-condition: no user row may still hold '*' before the new constraint is added.
do $$
declare
  wildcard_count integer;
begin
  select count(*) into wildcard_count from public.users where '*' = any(allowed_tags);
  if wildcard_count <> 0 then
    raise exception '% user row(s) still hold the "*" wildcard after migration; aborting before the constraint change.', wildcard_count;
  end if;
end
$$;

alter table public.users drop constraint users_star_tag_check;
alter table public.users
  add constraint users_no_wildcard_tag_check
  check (not ('*' = any(allowed_tags)));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_no_wildcard_tag_check'
      and conrelid = 'public.users'::regclass
  ) then
    raise exception 'users_no_wildcard_tag_check must exist on public.users after this migration';
  end if;

  if exists (select 1 from public.users where '*' = any(allowed_tags)) then
    raise exception 'A user row still holds the "*" wildcard after this migration.';
  end if;
end
$$;
