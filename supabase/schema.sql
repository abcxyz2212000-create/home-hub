-- 家の管理ハブ: Supabase database schema (first release)
-- Run this whole file once in the Supabase dashboard: SQL Editor -> New query -> Run.
-- It is idempotent: running it again does not delete data.
--
-- After running it, register the shared account as the only owner (replace the email):
--   insert into public.app_owner (user_id)
--   select id from auth.users where email = 'shared-account@example.com'
--   on conflict (singleton) do update set user_id = excluded.user_id;

-- ---------------------------------------------------------------------------
-- Owner: only this one user may read or write any data (checked by RLS).
-- ---------------------------------------------------------------------------
create table if not exists public.app_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique
);
alter table public.app_owner enable row level security;
-- No policies on purpose: the table is not readable through the API.

create or replace function public.is_app_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.app_owner where user_id = auth.uid());
$$;

revoke all on function public.is_app_owner() from public, anon;
grant execute on function public.is_app_owner() to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ledgers. Columns shared by every ledger:
--   name, holder, status, links, password_location, memo, tags, notify_days
-- notify_days: per-item notification override, e.g. {"card_expiry": [30, 7]}.
--   A missing key means "use the default timing", [] means "do not notify".
-- ---------------------------------------------------------------------------

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  holder text check (char_length(holder) <= 100),
  status text not null default 'active' check (status in ('active', 'closed')),
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  password_location text check (char_length(password_location) <= 200),
  memo text check (char_length(memo) <= 5000),
  tags text[] not null default '{}',
  notify_days jsonb not null default '{}'::jsonb check (jsonb_typeof(notify_days) = 'object'),
  institution text check (char_length(institution) <= 100),
  bank_code text check (bank_code ~ '^[0-9]{4}$'),
  branch text check (char_length(branch) <= 100),
  branch_code text check (branch_code ~ '^[0-9]{3}$'),
  kind text check (char_length(kind) <= 50),
  last4 text check (last4 ~ '^[0-9]{4}$'),
  purpose text check (char_length(purpose) <= 200),
  mf_linked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  holder text check (char_length(holder) <= 100),
  status text not null default 'active' check (status in ('active', 'closed')),
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  password_location text check (char_length(password_location) <= 200),
  memo text check (char_length(memo) <= 5000),
  tags text[] not null default '{}',
  notify_days jsonb not null default '{}'::jsonb check (jsonb_typeof(notify_days) = 'object'),
  brand text check (char_length(brand) <= 50),
  last4 text check (last4 ~ '^[0-9]{4}$'),
  expiry_ym text check (expiry_ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  debit_account_id uuid references public.accounts (id) on delete set null,
  closing_day smallint check (closing_day between 1 and 31),
  payment_day smallint check (payment_day between 1 and 31),
  annual_fee integer check (annual_fee between 0 and 10000000),
  annual_fee_month smallint check (annual_fee_month between 1 and 12),
  family_card boolean not null default false,
  etc_card boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  holder text check (char_length(holder) <= 100),
  status text not null default 'active' check (status in ('active', 'closed')),
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  password_location text check (char_length(password_location) <= 200),
  memo text check (char_length(memo) <= 5000),
  tags text[] not null default '{}',
  notify_days jsonb not null default '{}'::jsonb check (jsonb_typeof(notify_days) = 'object'),
  category text check (char_length(category) <= 50),
  amount integer check (amount between 0 and 100000000),
  cycle text check (cycle in ('monthly', 'yearly')),
  pay_card_id uuid references public.cards (id) on delete set null,
  pay_account_id uuid references public.accounts (id) on delete set null,
  contract_date date,
  renewal_date date,
  auto_renew boolean not null default false,
  cancel_method text check (char_length(cancel_method) <= 2000),
  contract_no text check (char_length(contract_no) <= 100),
  doc_location text check (char_length(doc_location) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pay_card_id is null or pay_account_id is null)
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  holder text check (char_length(holder) <= 100),
  status text not null default 'active' check (status in ('active', 'closed')),
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  password_location text check (char_length(password_location) <= 200),
  memo text check (char_length(memo) <= 5000),
  tags text[] not null default '{}',
  notify_days jsonb not null default '{}'::jsonb check (jsonb_typeof(notify_days) = 'object'),
  maker text check (char_length(maker) <= 100),
  model text check (char_length(model) <= 100),
  purchase_date date,
  shop text check (char_length(shop) <= 100),
  warranty_until date,
  manual_url text check (manual_url ~ '^https?://' and char_length(manual_url) <= 2000),
  location text check (char_length(location) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  holder text check (char_length(holder) <= 100),
  status text not null default 'active' check (status in ('active', 'closed')),
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  password_location text check (char_length(password_location) <= 200),
  memo text check (char_length(memo) <= 5000),
  tags text[] not null default '{}',
  notify_days jsonb not null default '{}'::jsonb check (jsonb_typeof(notify_days) = 'object'),
  issuer text check (char_length(issuer) <= 100),
  kind text check (char_length(kind) <= 50),
  member_last4 text check (member_last4 ~ '^[0-9]{4}$'),
  email text check (char_length(email) <= 254),
  card_id uuid references public.cards (id) on delete set null,
  points_expiry date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Photos attached to items (files live in the private storage bucket "item-photos").
create table if not exists public.item_photos (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  path text not null unique check (char_length(path) <= 300),
  thumb_path text not null unique check (char_length(thumb_path) <= 300),
  bytes integer not null default 0 check (bytes >= 0),
  created_at timestamptz not null default now()
);
create index if not exists item_photos_item_id_idx on public.item_photos (item_id);

-- App settings (shortcuts, last backup time, VAPID public key).
create table if not exists public.settings (
  key text primary key check (key ~ '^[a-z_]{1,50}$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Web Push subscriptions, one per device.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  device_label text check (char_length(device_label) <= 100),
  created_at timestamptz not null default now()
);

-- Sent notifications (used by scripts/notify.mjs to avoid duplicates). Service role only.
create table if not exists public.notification_log (
  key text primary key check (char_length(key) <= 200),
  sent_at timestamptz not null default now()
);

-- Upgrades for projects created from an older version of this file ("create table if not exists"
-- above does not add columns to an existing table). Safe to run any number of times.
alter table public.accounts add column if not exists bank_code text check (bank_code ~ '^[0-9]{4}$');
alter table public.accounts add column if not exists branch_code text check (branch_code ~ '^[0-9]{3}$');

create index if not exists cards_debit_account_id_idx on public.cards (debit_account_id);
create index if not exists contracts_pay_card_id_idx on public.contracts (pay_card_id);
create index if not exists contracts_pay_account_id_idx on public.contracts (pay_account_id);
create index if not exists memberships_card_id_idx on public.memberships (card_id);

-- ---------------------------------------------------------------------------
-- Triggers, privileges and row level security
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships', 'settings'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;

  foreach t in array array['app_owner', 'accounts', 'cards', 'contracts', 'items', 'memberships',
                           'item_photos', 'settings', 'push_subscriptions', 'notification_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    -- service_role (used only by the daily GitHub Actions job) bypasses RLS but still needs table
    -- privileges when "Automatically expose new tables" is off for the project.
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;

  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships',
                           'item_photos', 'settings', 'push_subscriptions'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_app_owner()) with check (public.is_app_owner())', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Usage statistics for the settings screen (owner only).
-- ---------------------------------------------------------------------------
create or replace function public.usage_stats()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_app_owner() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return json_build_object(
    'db_bytes', pg_database_size(current_database()),
    'storage_bytes', coalesce((
      select sum((metadata ->> 'size')::bigint) from storage.objects where bucket_id = 'item-photos'
    ), 0),
    'photo_count', (select count(*) from public.item_photos)
  );
end;
$$;

revoke all on function public.usage_stats() from public, anon;
grant execute on function public.usage_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for item photos (JPEG only, max 10 MB per file).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', false, 10485760, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists item_photos_owner_select on storage.objects;
drop policy if exists item_photos_owner_insert on storage.objects;
drop policy if exists item_photos_owner_update on storage.objects;
drop policy if exists item_photos_owner_delete on storage.objects;

create policy item_photos_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'item-photos' and public.is_app_owner());
create policy item_photos_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and public.is_app_owner());
create policy item_photos_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'item-photos' and public.is_app_owner())
  with check (bucket_id = 'item-photos' and public.is_app_owner());
create policy item_photos_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'item-photos' and public.is_app_owner());
