create extension if not exists pgcrypto;

create table if not exists public.users (
  email text primary key,
  name text not null check (btrim(name) <> ''),
  role text not null check (role in ('L1', 'L2', 'L3', 'L4', 'L5', 'L6')),
  allowed_tags text[] not null default '{}',
  active boolean not null default true,
  added_at timestamptz not null default now(),
  added_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_lower_check check (email = lower(email)),
  constraint users_domain_check check (email like '%@automationsystems.org'),
  constraint users_star_tag_check check (not ('*' = any (allowed_tags) and cardinality(allowed_tags) > 1))
);

create table if not exists public.customers (
  customer_id text primary key,
  name text not null check (btrim(name) <> ''),
  name_key text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  tags text[] not null default '{}',
  type text not null default '',
  priority text not null default '',
  area text not null default '',
  address text not null default '',
  gstin text not null default '',
  website text not null default '',
  notes text not null default '',
  sei text not null default '',
  remarks text not null default '',
  status text not null default 'Active' check (status in ('Active', 'Archived')),
  created_by text references public.users(email),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version >= 1)
);

create table if not exists public.contacts (
  contact_id text primary key,
  customer_id text not null references public.customers(customer_id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  designation text not null default '',
  phone text not null default '',
  email text not null default '',
  notes text not null default '',
  created_by text references public.users(email),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.handlers (
  customer_id text not null references public.customers(customer_id) on delete cascade,
  user_email text not null,
  assigned_by text references public.users(email),
  assigned_at timestamptz not null default now(),
  primary key (customer_id, user_email),
  constraint handlers_user_email_check check (
    user_email = 'direct'
    or (user_email = lower(user_email) and user_email like '%@automationsystems.org')
  )
);

create table if not exists public.cases (
  case_id text primary key,
  customer_id text not null references public.customers(customer_id),
  title text not null check (btrim(title) <> ''),
  details text not null default '',
  source text not null default '',
  stage text not null default 'Lead' check (stage in ('Lead', 'Opportunity', 'Quoted')),
  outcome text check (outcome is null or outcome in ('Won', 'Lost', 'Hold')),
  order_value numeric(14, 2) check (order_value is null or order_value >= 0),
  won_categories text not null default '',
  outcome_note text not null default '',
  owner text references public.users(email),
  extra_owners text not null default '',
  assignee text references public.users(email),
  closed_on timestamptz,
  created_by text references public.users(email),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1 check (version >= 1),
  constraint cases_won_requires_value_and_category check (
    outcome is distinct from 'Won'
    or (order_value is not null and order_value > 0 and btrim(won_categories) <> '')
  ),
  constraint cases_closed_outcome_check check (
    outcome not in ('Won', 'Lost')
    or (closed_on is not null and assignee is null)
  ),
  constraint cases_hold_open_check check (outcome is distinct from 'Hold' or closed_on is null)
);

create table if not exists public.actions (
  action_id text primary key,
  case_id text references public.cases(case_id) on delete cascade,
  customer_id text not null references public.customers(customer_id) on delete cascade,
  title text not null check (btrim(title) <> ''),
  due_date date,
  assignees text not null default '',
  status text not null default 'Open' check (status in ('Open', 'Done')),
  note text not null default '',
  created_by text references public.users(email),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by text references public.users(email),
  updated_at timestamptz not null default now()
);

create table if not exists public.quotations (
  quote_no text not null,
  rev integer not null check (rev >= 0),
  case_id text references public.cases(case_id),
  customer_id text not null references public.customers(customer_id),
  title text not null check (btrim(title) <> ''),
  source text not null check (source in ('Generated', 'External')),
  file_name text not null default '',
  upload_mime_type text not null default '',
  upload_data bytea,
  template_id text not null default '',
  template_name text not null default '',
  status text not null default 'Draft' check (status in ('Draft', 'Sent', 'Superseded')),
  subtotal numeric(14, 2) check (subtotal is null or subtotal >= 0),
  tax_pct numeric(7, 2) not null default 18 check (tax_pct >= 0),
  tax_amount numeric(14, 2) check (tax_amount is null or tax_amount >= 0),
  total numeric(14, 2) check (total is null or total >= 0),
  currency text not null default 'INR' check (btrim(currency) <> ''),
  valid_until date,
  notes text not null default '',
  doc_link text not null default '',
  pdf_link text not null default '',
  created_by text references public.users(email),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (quote_no, rev)
);

create table if not exists public.quote_boq (
  quote_no text not null,
  rev integer not null,
  block integer not null check (block > 0),
  title text not null default '',
  headers jsonb not null check (jsonb_typeof(headers) = 'array'),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  primary key (quote_no, rev, block),
  foreign key (quote_no, rev) references public.quotations(quote_no, rev) on delete cascade
);

create table if not exists public.recycle_bin (
  customer_id text primary key,
  name text not null check (btrim(name) <> ''),
  tags text[] not null default '{}',
  type text not null default '',
  priority text not null default '',
  area text not null default '',
  address text not null default '',
  gstin text not null default '',
  website text not null default '',
  notes text not null default '',
  sei text not null default '',
  remarks text not null default '',
  status text not null default 'Archived' check (status in ('Active', 'Archived')),
  created_by text,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_by text references public.users(email),
  deleted_at timestamptz not null default now(),
  snapshot jsonb not null default '{}'::jsonb
);

create table if not exists public.settings (
  key text primary key check (btrim(key) <> ''),
  value text not null
);

create table if not exists public.counters (
  key text primary key check (btrim(key) <> ''),
  last bigint not null default 0 check (last >= 0)
);

create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  who text references public.users(email),
  action text not null check (btrim(action) <> ''),
  entity text not null default '',
  customer_id text,
  details text not null default ''
);

create table if not exists public.import_customers (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null default gen_random_uuid(),
  row_no integer not null check (row_no > 0),
  name text not null default '',
  tag text not null default '',
  type text not null default '',
  priority text not null default '',
  area text not null default '',
  address text not null default '',
  gstin text not null default '',
  contact_name text not null default '',
  contact_designation text not null default '',
  contact_phone text not null default '',
  contact_email text not null default '',
  handlers text not null default '',
  status text not null default 'Pending' check (status in ('Pending', 'Imported', 'Skipped', 'Error')),
  error text not null default '',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.import_contacts (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null default gen_random_uuid(),
  row_no integer not null check (row_no > 0),
  customer_name text not null default '',
  contact_name text not null default '',
  designation text not null default '',
  phone text not null default '',
  email text not null default '',
  notes text not null default '',
  status text not null default 'Pending' check (status in ('Pending', 'Imported', 'Skipped', 'Error')),
  error text not null default '',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists users_active_role_idx on public.users(active, role);
create index if not exists users_allowed_tags_idx on public.users using gin(allowed_tags);

create index if not exists customers_status_idx on public.customers(status);
create index if not exists customers_name_key_idx on public.customers(name_key);
create index if not exists customers_tags_idx on public.customers using gin(tags);
create index if not exists customers_type_idx on public.customers(type);
create index if not exists customers_priority_idx on public.customers(priority);
create index if not exists customers_area_idx on public.customers(area);
create index if not exists customers_sei_idx on public.customers(sei);
create index if not exists customers_remarks_idx on public.customers(remarks);

create index if not exists contacts_customer_id_idx on public.contacts(customer_id);
create index if not exists handlers_user_email_idx on public.handlers(user_email);

create index if not exists cases_customer_id_idx on public.cases(customer_id);
create index if not exists cases_assignee_idx on public.cases(assignee);
create index if not exists cases_outcome_idx on public.cases(outcome);
create index if not exists cases_stage_idx on public.cases(stage);
create index if not exists cases_updated_at_idx on public.cases(updated_at desc);
create index if not exists cases_closed_on_idx on public.cases(closed_on desc);

create index if not exists actions_case_id_idx on public.actions(case_id);
create index if not exists actions_customer_id_idx on public.actions(customer_id);
create index if not exists actions_status_due_date_idx on public.actions(status, due_date);

create index if not exists quotations_case_id_idx on public.quotations(case_id);
create index if not exists quotations_customer_id_idx on public.quotations(customer_id);
create index if not exists quotations_status_idx on public.quotations(status);
create index if not exists quotations_active_revision_idx on public.quotations(quote_no, rev desc)
  where status in ('Draft', 'Sent');

create index if not exists recycle_bin_deleted_at_idx on public.recycle_bin(deleted_at desc);
create index if not exists activity_log_customer_id_idx on public.activity_log(customer_id);
create index if not exists activity_log_entity_idx on public.activity_log(entity);
create index if not exists activity_log_created_at_idx on public.activity_log(created_at desc);
create index if not exists activity_log_who_idx on public.activity_log(who);
create index if not exists import_customers_batch_idx on public.import_customers(import_batch_id, row_no);
create index if not exists import_contacts_batch_idx on public.import_contacts(import_batch_id, row_no);

insert into public.settings(key, value)
values
  ('STAGES', 'Lead | Opportunity | Quoted'),
  ('OUTCOMES', 'Won | Lost | Hold'),
  ('QUOTE_STATUSES', 'Draft | Sent | Superseded'),
  ('SOURCES', 'Direct Enquiry | Sales Team | Reference | Exhibition | Tender | Existing Customer | Other'),
  ('TAGS', 'Punjab | Chandigarh | NCR | Geo | Other'),
  ('TYPES', 'OEM | End User | EPC | Other'),
  ('PRIORITIES', 'High | Medium | Low'),
  ('CATEGORIES', 'VFDs | PLC | HMI | Panels | AVEVA | iMCC | Soft Starters | Motion Control & Robotics | Switchgear | Metering | EMS | BMS | Lighting, Switches, Wires | Pneumatics | Service | Others'),
  ('ROLES', 'L1 | L2 | L3 | L4 | L5 | L6'),
  ('TAX_PCT', '18'),
  ('CURRENCY', 'INR'),
  ('COMPANY', 'Automation Systems NG Pvt Ltd')
on conflict (key) do nothing;

insert into public.counters(key, last)
values
  ('customers', 0),
  ('contacts', 0),
  ('actions', 0)
on conflict (key) do nothing;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'users',
    'customers',
    'contacts',
    'handlers',
    'cases',
    'actions',
    'quotations',
    'quote_boq',
    'recycle_bin',
    'settings',
    'counters',
    'activity_log',
    'import_customers',
    'import_contacts'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);

    execute format('drop policy if exists deny_direct_select on public.%I', table_name);
    execute format('drop policy if exists deny_direct_insert on public.%I', table_name);
    execute format('drop policy if exists deny_direct_update on public.%I', table_name);
    execute format('drop policy if exists deny_direct_delete on public.%I', table_name);

    execute format('create policy deny_direct_select on public.%I for select to anon, authenticated using (false)', table_name);
    execute format('create policy deny_direct_insert on public.%I for insert to anon, authenticated with check (false)', table_name);
    execute format('create policy deny_direct_update on public.%I for update to anon, authenticated using (false) with check (false)', table_name);
    execute format('create policy deny_direct_delete on public.%I for delete to anon, authenticated using (false)', table_name);
  end loop;
end $$;

revoke all on all sequences in schema public from anon, authenticated;
