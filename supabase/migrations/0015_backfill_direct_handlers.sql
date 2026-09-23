-- Ghost-visibility fix (src/server/auth/access.ts caseHandlers): a case whose account has no
-- real handler is now owned by the virtual `direct` account instead of falling back to whoever
-- created the case. That only works if every customer has at least one handler row, so any
-- customer with none gets backfilled to `direct` here.
--
-- assigned_by is left null rather than a sentinel string: public.handlers.assigned_by references
-- public.users(email), and no such migration user exists there, so a sentinel would violate the
-- foreign key. null is the honest value for "no human assigned this".
--
-- scripts/apply-migrations.mjs wraps each file in a single transaction; do not BEGIN/COMMIT here.

set local lock_timeout = '3s';

insert into public.handlers (customer_id, user_email, assigned_by, assigned_at)
select c.customer_id, 'direct', null, now()
from public.customers c
where not exists (select 1 from public.handlers h where h.customer_id = c.customer_id);

do $$
declare
  orphan_count integer;
begin
  select count(*) into orphan_count
  from public.customers c
  where not exists (select 1 from public.handlers h where h.customer_id = c.customer_id);

  if orphan_count <> 0 then
    raise exception 'every customer must have at least one handler row after this migration, found %', orphan_count;
  end if;
end $$;
