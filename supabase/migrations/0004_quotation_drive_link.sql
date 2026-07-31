alter table public.quotations
  add column if not exists drive_file_id text not null default '',
  add column if not exists drive_view_link text not null default '',
  add column if not exists drive_saved_at timestamptz,
  add column if not exists drive_saved_by text references public.users(email);
