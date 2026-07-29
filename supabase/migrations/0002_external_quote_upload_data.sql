alter table public.quotations
  add column if not exists upload_mime_type text not null default '',
  add column if not exists upload_data bytea;
