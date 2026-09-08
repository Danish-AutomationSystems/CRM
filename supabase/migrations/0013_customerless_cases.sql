-- Leads and opportunities can precede customer identification. Keep the existing FK.
alter table public.cases alter column customer_id drop not null;
alter table public.cases add constraint cases_quoted_customer_check
  check ((stage <> 'Quoted' and outcome is distinct from 'Won') or customer_id is not null);
