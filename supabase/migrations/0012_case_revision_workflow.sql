-- Case revision workflow: Quoted cases deliberately have no ticket holder.
--
-- NOTE: scripts/apply-migrations.mjs already wraps each file in a single transaction
-- (sql.begin), so this file must NOT issue its own BEGIN/COMMIT - doing so would commit
-- before the schema_migrations bookkeeping row is written. Everything below is atomic.

-- Fail fast rather than queueing for the ACCESS EXCLUSIVE lock behind a long read.
-- public.cases is read by the case list, the case page, and every dashboard; all of
-- them would block behind us while we waited.
set local lock_timeout = '3s';

alter table public.cases drop constraint if exists cases_stage_check;
alter table public.cases add constraint cases_stage_check
  check (stage in ('Lead', 'Opportunity', 'Quoted', 'Revision'));

-- Repair legacy rows before enforcing the invariant. Owners are separate columns
-- and remain untouched. Keep an audit trail for operators reviewing the cleanup:
-- `who` is the cleared holder itself (assignee is FK'd to public.users(email), the
-- same type activity_log.who expects - see 0001_initial_schema.sql:77 and :184), and
-- `details` repeats it in plain text so the row is legible without joining back to a
-- since-cleared cases.assignee value.
insert into public.activity_log (who, action, entity, customer_id, details)
select assignee, 'CASE_QUOTED_HOLDER_CLEARED', case_id, customer_id,
       'Quoted holder cleared by revision-workflow migration: ' || assignee
from public.cases
where stage = 'Quoted' and assignee is not null;

update public.cases
set assignee = null, updated_at = now(), version = version + 1
where stage = 'Quoted' and assignee is not null;

alter table public.cases add constraint cases_quoted_unassigned_check
  check (stage <> 'Quoted' or assignee is null);

do $$
declare
  remaining_count bigint;
begin
  select count(*) into remaining_count
    from public.cases
   where stage = 'Quoted' and assignee is not null;

  if remaining_count <> 0 then
    raise exception 'cases_quoted_unassigned_check: % Quoted case(s) still carry an assignee after cleanup', remaining_count;
  end if;
end $$;
