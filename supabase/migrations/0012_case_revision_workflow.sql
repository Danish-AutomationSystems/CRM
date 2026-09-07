-- Case revision workflow: Quoted cases deliberately have no ticket holder.
set local lock_timeout = '3s';

alter table public.cases drop constraint if exists cases_stage_check;
alter table public.cases add constraint cases_stage_check
  check (stage in ('Lead', 'Opportunity', 'Quoted', 'Revision'));

-- Repair legacy rows before enforcing the invariant. Owners are separate columns
-- and remain untouched. Keep an audit trail for operators reviewing the cleanup.
insert into public.activity_log (who, action, entity, customer_id, details)
select coalesce(created_by, owner), 'CASE_QUOTED_HOLDER_CLEARED', case_id, customer_id,
       'Quoted holder cleared by revision-workflow migration'
from public.cases
where stage = 'Quoted' and assignee is not null;

update public.cases
set assignee = null, updated_at = now(), version = version + 1
where stage = 'Quoted' and assignee is not null;

alter table public.cases add constraint cases_quoted_unassigned_check
  check (stage <> 'Quoted' or assignee is null);

insert into public.settings(key, value) values ('STAGES', 'Lead | Opportunity | Quoted | Revision')
on conflict (key) do update set value = excluded.value;
