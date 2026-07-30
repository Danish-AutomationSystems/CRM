-- Migration 0003: Performance Indexes for AS CRM
-- Accelerates list filtering, stage grouping, and due-date action queries.

create index if not exists customers_status_created_idx on public.customers(status, created_at desc);
create index if not exists customers_type_priority_idx on public.customers(type, priority) where status = 'Active';

create index if not exists cases_customer_stage_idx on public.cases(customer_id, stage);
create index if not exists cases_owner_outcome_idx on public.cases(owner, outcome);

create index if not exists actions_case_due_idx on public.actions(case_id, due_date) where status = 'Open';
create index if not exists actions_customer_status_idx on public.actions(customer_id, status);

create index if not exists quotations_customer_created_idx on public.quotations(customer_id, created_at desc);
