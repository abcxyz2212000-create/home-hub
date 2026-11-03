-- 家の管理ハブ: Supabase database schema
-- Run this whole file in the Supabase dashboard: SQL Editor -> New query -> Run.
-- It is idempotent: running it again does not delete data. It works both for a new project and
-- for upgrading a project created from an older version of this file.
--
-- New project only: register the first administrator (replace the name and the email):
--   insert into public.members (name, email, role)
--   values ('共通（管理者）', 'shared-account@example.com', 'admin');

-- ---------------------------------------------------------------------------
-- Members (user master). A member with an email can log in with the Supabase Auth user that has
-- the same email; a member without an email is a family member who does not log in (e.g. an
-- account holder). Only active members can read or write data (checked by RLS).
-- ---------------------------------------------------------------------------
create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 50),
  nickname text check (char_length(nickname) between 1 and 30),
  email text unique check (
    email is null
    or (char_length(email) <= 254 and email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
  ),
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true,
  memo text check (char_length(memo) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.current_member_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.members
  where active and email is not null and email = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_member_id() is not null;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.members where id = public.current_member_id() and role = 'admin');
$$;

revoke all on function public.current_member_id() from public, anon;
revoke all on function public.is_member() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.current_member_id() to authenticated;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_admin() to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ledgers. Columns shared by every ledger:
--   name, holder_id, status, links, password_location, memo, tags, notify_days,
--   created_by, updated_by (holder_id/created_by/updated_by are added in the upgrade section below)
-- notify_days: per-item notification override, e.g. {"card_expiry": [30, 7]}.
--   A missing key means "use the default timing", [] means "do not notify".
-- ---------------------------------------------------------------------------

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
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
  account_no text check (account_no ~ '^[0-9]{4,14}$'),
  last4 text check (last4 ~ '^[0-9]{4}$'),
  purpose text check (char_length(purpose) <= 200),
  mf_linked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'closed')),
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  password_location text check (char_length(password_location) <= 200),
  memo text check (char_length(memo) <= 5000),
  tags text[] not null default '{}',
  notify_days jsonb not null default '{}'::jsonb check (jsonb_typeof(notify_days) = 'object'),
  kind text check (kind in ('クレジット', 'デビット', 'キャッシュ', 'プリペイド', 'その他')),
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
  shared_cost boolean not null default false,
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

-- Change history (append-only; written only by the audit trigger below).
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  table_name text not null,
  record_id uuid not null,
  record_name text,
  action text not null check (action in ('insert', 'update', 'delete', 'photo_insert', 'photo_delete')),
  actor_member_id uuid references public.members (id) on delete set null,
  actor_name text not null,
  changes jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_record_idx on public.audit_log (table_name, record_id, at desc);

-- Household chores (plan and workload). schedule holds weekdays 0-6 (week), days 1-31 (month) or
-- months 1-12 (year); when it is not empty, times = number of entries (kept in sync by the app).
create table if not exists public.chores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'closed')),
  category text check (char_length(category) <= 20),
  chore_group text check (char_length(chore_group) <= 20),
  cycle text not null default 'week' check (cycle in ('day', 'week', 'month', 'year', 'adhoc')),
  schedule jsonb not null default '[]'::jsonb check (jsonb_typeof(schedule) = 'array'),
  times numeric(7, 2) check (times > 0 and times <= 1000),
  minutes numeric(7, 1) check (minutes >= 0 and minutes <= 10000),
  adjust numeric(4, 2) not null default 1.0 check (adjust > 0 and adjust <= 5),
  points_override numeric(10, 2) check (points_override >= 0 and points_override <= 1000000),
  assignee_type text not null default 'member' check (assignee_type in ('member', 'all', 'tbd')),
  assignee_id uuid references public.members (id) on delete set null,
  memo text check (char_length(memo) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.members (id) on delete set null,
  updated_by uuid references public.members (id) on delete set null
);
create index if not exists chores_assignee_id_idx on public.chores (assignee_id);

-- Shared account deposits (共通口座の入金管理). Each member owes the shared account every month:
--   recurring rules (基本・家賃・dアニ ...) for the months between start_ym and end_ym
--   + one-off charges (管理費・立替 ...; minus = a shared cost the member paid personally)
--   - deposits. The remaining amount is carried over to the next month (computed by the app).
create table if not exists public.shared_rules (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete restrict,
  label text not null check (char_length(label) between 1 and 50),
  amount integer not null check (amount between -10000000 and 10000000 and amount <> 0),
  start_ym text not null check (start_ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  end_ym text check (end_ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  month_of_year smallint check (month_of_year between 1 and 12),
  contract_id uuid references public.contracts (id) on delete set null,
  memo text check (char_length(memo) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.members (id) on delete set null,
  updated_by uuid references public.members (id) on delete set null,
  check (end_ym is null or end_ym >= start_ym)
);
create index if not exists shared_rules_member_id_idx on public.shared_rules (member_id);

create table if not exists public.shared_entries (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete restrict,
  ym text not null check (ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind text not null check (kind in ('charge', 'deposit', 'adjust')),
  label text not null check (char_length(label) between 1 and 50),
  amount integer not null check (amount between -100000000 and 100000000 and amount <> 0),
  memo text check (char_length(memo) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.members (id) on delete set null,
  updated_by uuid references public.members (id) on delete set null,
  check (kind <> 'deposit' or amount > 0)
);
create index if not exists shared_entries_member_ym_idx on public.shared_entries (member_id, ym);

-- Statement lines of the shared account and the cards paid from it, imported from MoneyForward ME CSV
-- (one row per MoneyForward ID, so importing the same period again updates instead of duplicating).
-- Not copied into the history (audit_log): many rows per month, and they come from the bank anyway.
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  mf_id text not null unique check (char_length(mf_id) between 1 and 100),
  date date not null,
  description text not null check (char_length(description) <= 500),
  amount integer not null check (amount between -1000000000 and 1000000000),
  institution text check (char_length(institution) <= 100),
  account_id uuid references public.accounts (id) on delete set null,
  card_id uuid references public.cards (id) on delete set null,
  category text check (char_length(category) <= 50),
  subcategory text check (char_length(subcategory) <= 50),
  memo text check (char_length(memo) <= 1000),
  counted boolean not null default true,
  transfer boolean not null default false,
  contract_id uuid references public.contracts (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.members (id) on delete set null,
  updated_by uuid references public.members (id) on delete set null
);
create index if not exists transactions_date_idx on public.transactions (date);
create index if not exists transactions_contract_id_idx on public.transactions (contract_id);

-- ---------------------------------------------------------------------------
-- Upgrades for projects created from an older version of this file ("create table if not exists"
-- above does not add columns to an existing table). Safe to run any number of times.
-- ---------------------------------------------------------------------------
alter table public.accounts add column if not exists bank_code text check (bank_code ~ '^[0-9]{4}$');
alter table public.accounts add column if not exists branch_code text check (branch_code ~ '^[0-9]{3}$');
-- Full account number (decided 2026-11-01 when migrating from Google Drive). last4 is derived from it by the app.
alter table public.accounts add column if not exists account_no text check (account_no ~ '^[0-9]{4,14}$');
alter table public.push_subscriptions add column if not exists member_id uuid references public.members (id) on delete set null;
-- Nickname used on screens (holder fields keep the legal name). Added 2026-11-01.
alter table public.members add column if not exists nickname text check (char_length(nickname) between 1 and 30);
create unique index if not exists members_nickname_key on public.members (nickname) where nickname is not null;
-- Card type (credit / debit / ...). Added 2026-11-01 when the ledger was renamed to "カード".
alter table public.cards add column if not exists kind text check (kind in ('クレジット', 'デビット', 'キャッシュ', 'プリペイド', 'その他'));
-- Contracts paid from a personal account for the household (共通の費用) are deducted from the holder's
-- monthly amount for the shared account through a recurring rule kept by the app. Added 2026-11-01.
alter table public.contracts add column if not exists shared_cost boolean not null default false;
alter table public.shared_rules add column if not exists month_of_year smallint check (month_of_year between 1 and 12);
alter table public.shared_rules add column if not exists contract_id uuid references public.contracts (id) on delete set null;
create index if not exists shared_rules_contract_id_idx on public.shared_rules (contract_id);
-- MoneyForward ME import (2026-11-01): the name of the account/card in MoneyForward ("保有金融機関"),
-- and words that identify a contract in the statement ("内容").
alter table public.accounts add column if not exists mf_name text check (char_length(mf_name) <= 100);
alter table public.cards add column if not exists mf_name text check (char_length(mf_name) <= 100);
alter table public.contracts add column if not exists match_keywords text check (char_length(match_keywords) <= 500);
-- Statement lines paid by the shared account but owed by one person (個人負担, 2026-11-01): who owes
-- it, whether it is still being checked, and the one-off charge (臨時の費目) that settled it.
alter table public.transactions add column if not exists personal_member_id uuid references public.members (id) on delete set null;
alter table public.transactions add column if not exists needs_review boolean not null default false;
alter table public.transactions add column if not exists settled_entry_id uuid references public.shared_entries (id) on delete set null;
create index if not exists transactions_personal_idx on public.transactions (personal_member_id) where personal_member_id is not null;
-- Deposits recognised from the statement (2026-11-01): the payer names a member uses at the bank
-- (振込名義, 「、」区切り), the deposit record made from a statement line, and lines whose record was
-- deleted on purpose (so that importing again does not make it again).
alter table public.members add column if not exists transfer_names text check (char_length(transfer_names) <= 300);
-- The person's color in the app (2026-11-01): male = blue, female = red.
alter table public.members add column if not exists gender text check (gender in ('male', 'female'));
-- birth year (2026-11-03): the age group in the wage statistics that set the ratio of the budget
alter table public.members add column if not exists birth_year integer check (birth_year between 1900 and 2100);
-- The hour (Japan time, 0-23) the person gets notifications; null = 8 (2026-11-01).
alter table public.members add column if not exists notify_hour smallint check (notify_hour between 0 and 23);
alter table public.transactions add column if not exists deposit_entry_id uuid references public.shared_entries (id) on delete set null;
alter table public.transactions add column if not exists deposit_ignored boolean not null default false;
-- Contract amounts by period (2026-11-01): [{ amount, from, to }] ('YYYY-MM', to null = current).
alter table public.contracts add column if not exists price_history jsonb not null default '[]'::jsonb check (jsonb_typeof(price_history) = 'array');
-- 立替 by date (2026-11-01): the day it was paid (its month decides the month of the one-off item).
alter table public.shared_entries add column if not exists paid_on date;
-- 調整 (2026-11-03): a correction of what a person pays (settlements, per-category ratios), either sign;
-- neither 負担額 nor 立替. Only administrators write it (the member policies allow 'charge' only).
alter table public.shared_entries drop constraint if exists shared_entries_kind_check;
alter table public.shared_entries add constraint shared_entries_kind_check check (kind in ('charge', 'deposit', 'adjust'));
alter table public.shared_entries drop constraint if exists shared_entries_check;
alter table public.shared_entries add constraint shared_entries_check check (kind <> 'deposit' or amount > 0);
-- Deposit reports (入金報告, 2026-11-01): what a member says they paid in, with the bank's completion
-- screen. Kept for reference only; the deposit records come from the statement.
create table if not exists public.deposit_reports (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete restrict,
  paid_on date not null,
  amount integer not null check (amount between 1 and 100000000),
  memo text check (char_length(memo) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.members (id) on delete set null,
  updated_by uuid references public.members (id) on delete set null
);
create index if not exists deposit_reports_member_idx on public.deposit_reports (member_id, paid_on);
-- Balances of an account at the end of a day, from the bank's statement CSV (2026-11-01). Lines come
-- from MoneyForward; only balances are kept here.
create table if not exists public.account_balances (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  date date not null,
  balance bigint not null,
  created_at timestamptz not null default now(),
  unique (account_id, date)
);
-- Budget (予実管理, 2026-11-03): a monthly amount per 費目 (MoneyForward's 大項目) for each year, and
-- per year the monthly savings target and the ratio of the people ({ member id: weight }).
create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  year integer not null check (year between 2000 and 2100),
  category text not null check (char_length(category) between 1 and 50),
  monthly integer not null default 0 check (monthly between 0 and 100000000),
  memo text check (char_length(memo) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (year, category)
);
create table if not exists public.budget_years (
  id uuid primary key default gen_random_uuid(),
  year integer not null unique check (year between 2000 and 2100),
  savings_monthly integer not null default 0 check (savings_monthly between -100000000 and 100000000),
  ratio jsonb not null default '{}'::jsonb check (jsonb_typeof(ratio) = 'object'),
  ratio_note text check (char_length(ratio_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- the monthly income of the year (what the two put in): each person's base = income x ratio,
-- savings = income - spending budget (2026-11-03)
alter table public.budget_years add column if not exists income_monthly integer check (income_monthly between 0 and 100000000);
-- 費目ごとの負担率 (2026-11-03): [{ category, subcategory|null, ratio: { member_id: percent }, from: 'YYYY-MM' }]
alter table public.budget_years add column if not exists category_ratios jsonb not null default '[]'::jsonb check (jsonb_typeof(category_ratios) = 'array');
-- Evidence of a year's budget (the wage statistics the ratio was taken from, 2026-11-03): files in the
-- private storage bucket "evidence".
create table if not exists public.budget_attachments (
  id uuid primary key default gen_random_uuid(),
  year integer not null check (year between 2000 and 2100),
  path text not null unique check (char_length(path) <= 300),
  name text not null check (char_length(name) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  bytes integer not null default 0 check (bytes between 0 and 5242880),
  created_at timestamptz not null default now(),
  created_by uuid default public.current_member_id() references public.members (id) on delete set null
);
create index if not exists budget_attachments_year_idx on public.budget_attachments (year);
-- Images attached to a one-off item (receipt) or a deposit report (completion screen), stored in the
-- item-photos bucket.
create table if not exists public.shared_attachments (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid references public.shared_entries (id) on delete cascade,
  report_id uuid references public.deposit_reports (id) on delete cascade,
  path text not null unique check (char_length(path) <= 300),
  thumb_path text not null unique check (char_length(thumb_path) <= 300),
  bytes integer not null default 0 check (bytes >= 0),
  created_at timestamptz not null default now(),
  created_by uuid default public.current_member_id() references public.members (id) on delete set null,
  check (num_nonnulls(entry_id, report_id) = 1)
);
create index if not exists shared_attachments_entry_idx on public.shared_attachments (entry_id) where entry_id is not null;
create index if not exists shared_attachments_report_idx on public.shared_attachments (report_id) where report_id is not null;

do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships'] loop
    execute format('alter table public.%I add column if not exists holder_id uuid references public.members (id) on delete set null', t);
    execute format('create index if not exists %I on public.%I (holder_id)', t || '_holder_id_idx', t);
  end loop;
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships', 'item_photos'] loop
    execute format('alter table public.%I add column if not exists created_by uuid references public.members (id) on delete set null', t);
    execute format('alter table public.%I add column if not exists updated_by uuid references public.members (id) on delete set null', t);
  end loop;
end;
$$;

-- Migration from the single-owner version (app_owner table, free-text holder, settings "members").
do $$
declare
  t text;
begin
  -- the former owner becomes the first administrator
  if to_regclass('public.app_owner') is not null and not exists (select 1 from public.members where role = 'admin') then
    execute $q$
      insert into public.members (name, email, role)
      select '共通（管理者）', lower(u.email), 'admin'
      from public.app_owner o join auth.users u on u.id = o.user_id
      where u.email is not null
      on conflict do nothing
    $q$;
  end if;
  -- family names registered on the old settings screen become members without login
  insert into public.members (name)
  select distinct trim(x) from public.settings s, jsonb_array_elements_text(s.value) x
  where s.key = 'members' and jsonb_typeof(s.value) = 'array' and trim(x) <> ''
  on conflict do nothing;
  -- free-text holders become members without login and are linked by holder_id
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships'] loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = t and column_name = 'holder') then
      execute format($q$
        insert into public.members (name)
        select distinct left(trim(holder), 50) from public.%I where holder is not null and trim(holder) <> ''
        on conflict do nothing
      $q$, t);
      execute format($q$
        update public.%I x set holder_id = m.id from public.members m
        where x.holder_id is null and x.holder is not null and m.name = left(trim(x.holder), 50)
      $q$, t);
    end if;
  end loop;
end;
$$;

create index if not exists cards_debit_account_id_idx on public.cards (debit_account_id);
create index if not exists contracts_pay_card_id_idx on public.contracts (pay_card_id);
create index if not exists contracts_pay_account_id_idx on public.contracts (pay_account_id);
create index if not exists memberships_card_id_idx on public.memberships (card_id);

-- ---------------------------------------------------------------------------
-- Who created / last changed each row, the change history, and the last-admin guard
-- ---------------------------------------------------------------------------
create or replace function public.stamp_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := public.current_member_id();
    new.updated_by := new.created_by;
  else
    new.created_by := old.created_by;
    new.updated_by := public.current_member_id();
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  diff jsonb := '{}'::jsonb;
  k text;
  ov jsonb;
  nv jsonb;
  actor uuid := public.current_member_id();
  tbl text := tg_table_name;
  rid uuid := (r ->> 'id')::uuid;
  act text := lower(tg_op);
  rname text := coalesce(r ->> 'name', r ->> 'label');
begin
  if tg_table_name = 'item_photos' then
    if tg_op = 'UPDATE' then
      return null;
    end if;
    tbl := 'items';
    rid := (r ->> 'item_id')::uuid;
    act := 'photo_' || lower(tg_op);
    rname := (select name from public.items where id = rid);
  elsif tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      continue when k = any (array['id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'last4']);
      ov := o -> k;
      nv := n -> k;
      continue when ov is not distinct from nv;
      if k = 'account_no' then
        -- the full account number is never copied into the history
        ov := case when jsonb_typeof(ov) = 'string' then to_jsonb('●●●' || right(ov #>> '{}', 4)) else ov end;
        nv := case when jsonb_typeof(nv) = 'string' then to_jsonb('●●●' || right(nv #>> '{}', 4)) else nv end;
      end if;
      diff := diff || jsonb_build_object(k, jsonb_build_array(ov, nv));
    end loop;
    if diff = '{}'::jsonb then
      return null;
    end if;
  end if;
  insert into public.audit_log (table_name, record_id, record_name, action, actor_member_id, actor_name, changes)
  values (
    tbl, rid, rname, act, actor,
    coalesce((select coalesce(nickname, name) from public.members where id = actor),
             case when auth.uid() is null then '管理ツール' else '登録されていないユーザー' end),
    diff
  );
  return null;
end;
$$;

create or replace function public.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.members where role = 'admin' and active and email is not null) then
    raise exception 'at least one active administrator with a login is required' using errcode = 'HH001';
  end if;
  return null;
end;
$$;

revoke all on function public.stamp_row() from public, anon, authenticated;
revoke all on function public.audit_row() from public, anon, authenticated;
revoke all on function public.guard_last_admin() from public, anon, authenticated;

-- Attachments: the parent record is the logged-in member's own (one-off item or deposit report).
create or replace function public.owns_attachment_parent(p_entry uuid, p_report uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select e.member_id = public.current_member_id() and e.kind = 'charge' from public.shared_entries e where e.id = p_entry),
    (select r.member_id = public.current_member_id() from public.deposit_reports r where r.id = p_report),
    false);
$$;
revoke all on function public.owns_attachment_parent(uuid, uuid) from public, anon;
grant execute on function public.owns_attachment_parent(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Triggers, privileges and row level security
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships', 'chores', 'shared_rules', 'shared_entries', 'transactions', 'deposit_reports'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('drop trigger if exists %I_stamp on public.%I', t, t);
    execute format('create trigger %I_stamp before insert or update on public.%I for each row execute function public.stamp_row()', t, t);
  end loop;
  execute 'drop trigger if exists item_photos_stamp on public.item_photos';
  execute 'create trigger item_photos_stamp before insert or update on public.item_photos for each row execute function public.stamp_row()';
  foreach t in array array['settings', 'members', 'budgets', 'budget_years'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships', 'item_photos', 'members', 'chores', 'shared_rules', 'shared_entries', 'deposit_reports'] loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.audit_row()', t, t);
  end loop;
  execute 'drop trigger if exists members_guard_last_admin on public.members';
  execute 'create trigger members_guard_last_admin after update or delete on public.members for each statement execute function public.guard_last_admin()';

  foreach t in array array['members', 'accounts', 'cards', 'contracts', 'items', 'memberships',
                           'item_photos', 'settings', 'push_subscriptions', 'notification_log', 'audit_log', 'chores', 'shared_rules', 'shared_entries', 'transactions',
                           'deposit_reports', 'shared_attachments', 'account_balances', 'budgets', 'budget_years', 'budget_attachments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    -- service_role (used only by the daily GitHub Actions job) bypasses RLS but still needs table
    -- privileges when "Automatically expose new tables" is off for the project.
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('drop policy if exists owner_all on public.%I', t);
  end loop;

  -- household data: every active member can read and write
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships', 'item_photos', 'push_subscriptions', 'chores', 'transactions'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists member_all on public.%I', t);
    execute format('create policy member_all on public.%I for all to authenticated using (public.is_member()) with check (public.is_member())', t);
  end loop;

  -- shared account ledger (2026-11-01): everyone reads; administrators write everything.
  --   shared_entries: a member adds, changes and deletes only their own one-off items (立替 etc.);
  --                   deposits come from the statement import (administrators).
  --   shared_rules:   recurring items are kept by administrators; rules linked to a contract follow the
  --                   contract, which any member may edit, so those stay writable.
  foreach t in array array['shared_rules', 'shared_entries', 'deposit_reports', 'shared_attachments'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists member_all on public.%I', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('drop policy if exists member_write on public.%I', t);
    execute format('drop policy if exists member_insert on public.%I', t);
    execute format('drop policy if exists member_update on public.%I', t);
    execute format('drop policy if exists member_delete on public.%I', t);
    execute format('create policy member_read on public.%I for select to authenticated using (public.is_member())', t);
  end loop;
  create policy member_insert on public.shared_entries for insert to authenticated
    with check (public.is_admin() or (public.is_member() and kind = 'charge' and member_id = public.current_member_id()));
  create policy member_update on public.shared_entries for update to authenticated
    using (public.is_admin() or (public.is_member() and kind = 'charge' and member_id = public.current_member_id()))
    with check (public.is_admin() or (public.is_member() and kind = 'charge' and member_id = public.current_member_id()));
  create policy member_delete on public.shared_entries for delete to authenticated
    using (public.is_admin() or (public.is_member() and kind = 'charge' and member_id = public.current_member_id()));
  create policy member_insert on public.shared_rules for insert to authenticated
    with check (public.is_admin() or (public.is_member() and contract_id is not null));
  create policy member_update on public.shared_rules for update to authenticated
    using (public.is_admin() or (public.is_member() and contract_id is not null))
    with check (public.is_admin() or (public.is_member() and contract_id is not null));
  create policy member_delete on public.shared_rules for delete to authenticated
    using (public.is_admin() or (public.is_member() and contract_id is not null));
  -- account balances: everyone reads, administrators import
  grant select, insert, update, delete on public.account_balances to authenticated;
  drop policy if exists member_read on public.account_balances;
  drop policy if exists admin_write on public.account_balances;
  create policy member_read on public.account_balances for select to authenticated using (public.is_member());
  create policy admin_write on public.account_balances for all to authenticated using (public.is_admin()) with check (public.is_admin());
  -- budget: everyone reads, administrators set it
  foreach t in array array['budgets', 'budget_years', 'budget_attachments'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('drop policy if exists admin_write on public.%I', t);
    execute format('create policy member_read on public.%I for select to authenticated using (public.is_member())', t);
    execute format('create policy admin_write on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
  -- deposit reports: a member reports only their own
  create policy member_insert on public.deposit_reports for insert to authenticated
    with check (public.is_admin() or (public.is_member() and member_id = public.current_member_id()));
  create policy member_update on public.deposit_reports for update to authenticated
    using (public.is_admin() or (public.is_member() and member_id = public.current_member_id()))
    with check (public.is_admin() or (public.is_member() and member_id = public.current_member_id()));
  create policy member_delete on public.deposit_reports for delete to authenticated
    using (public.is_admin() or (public.is_member() and member_id = public.current_member_id()));
  -- attachments follow the record they belong to
  create policy member_insert on public.shared_attachments for insert to authenticated
    with check (public.is_admin() or (public.is_member() and public.owns_attachment_parent(entry_id, report_id)));
  create policy member_update on public.shared_attachments for update to authenticated
    using (public.is_admin()) with check (public.is_admin());
  create policy member_delete on public.shared_attachments for delete to authenticated
    using (public.is_admin() or (public.is_member() and public.owns_attachment_parent(entry_id, report_id)));

  -- user master and settings: members read, administrators write
  -- (exception: everyone may record the last backup time)
  foreach t in array array['members', 'settings'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('drop policy if exists admin_insert on public.%I', t);
    execute format('drop policy if exists admin_update on public.%I', t);
    execute format('drop policy if exists admin_delete on public.%I', t);
    execute format('create policy member_read on public.%I for select to authenticated using (public.is_member())', t);
    execute format('create policy admin_delete on public.%I for delete to authenticated using (public.is_admin())', t);
  end loop;
  create policy admin_insert on public.members for insert to authenticated with check (public.is_admin());
  create policy admin_update on public.members for update to authenticated using (public.is_admin()) with check (public.is_admin());
  create policy admin_insert on public.settings for insert to authenticated
    with check (public.is_admin() or (public.is_member() and key = 'last_backup_at'));
  create policy admin_update on public.settings for update to authenticated
    using (public.is_admin() or (public.is_member() and key = 'last_backup_at'))
    with check (public.is_admin() or (public.is_member() and key = 'last_backup_at'));

  -- history: read-only for members (rows are added by the audit trigger only)
  grant select on public.audit_log to authenticated;
  drop policy if exists member_read on public.audit_log;
  create policy member_read on public.audit_log for select to authenticated using (public.is_member());
end;
$$;

-- Created by Supabase when "Enable automatic RLS" is turned on in the project settings. It does not need to be
-- callable through the API by anyone (Supabase's security advisor flags it), so close it. Does nothing if the
-- function does not exist.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Usage statistics for the settings screen (members only).
-- ---------------------------------------------------------------------------
create or replace function public.usage_stats()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_member() then
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

-- Each person sets their own notification hour (the user master is otherwise written by administrators).
create or replace function public.set_my_notify_hour(p_hour integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_member() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_hour is not null and (p_hour < 0 or p_hour > 23) then
    raise exception 'hour must be 0-23' using errcode = '22023';
  end if;
  update public.members set notify_hour = p_hour where id = public.current_member_id();
end;
$$;
revoke all on function public.set_my_notify_hour(integer) from public, anon;
grant execute on function public.set_my_notify_hour(integer) to authenticated;

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
  using (bucket_id = 'item-photos' and public.is_member());
create policy item_photos_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and public.is_member());
create policy item_photos_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'item-photos' and public.is_member())
  with check (bucket_id = 'item-photos' and public.is_member());
create policy item_photos_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'item-photos' and public.is_member());

-- Private bucket for evidence of the budget (PDF, JPEG, PNG, max 5 MB): everyone reads, administrators
-- add and remove.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 5242880, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists evidence_read on storage.objects;
drop policy if exists evidence_insert on storage.objects;
drop policy if exists evidence_delete on storage.objects;
create policy evidence_read on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and public.is_member());
create policy evidence_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'evidence' and public.is_admin());
create policy evidence_delete on storage.objects for delete to authenticated
  using (bucket_id = 'evidence' and public.is_admin());

-- ---------------------------------------------------------------------------
-- お知らせ (2026-11-03): what the app sent to devices (kind 'system') and messages people write to each
-- other (kind 'message'), seen by everyone on one page. A message can be scheduled (deliver_at); the
-- GitHub Actions job pushes it to the devices of its recipients and sets delivered_at.
-- to_members: the recipients; empty = everyone. key: one system notice per alert (no duplicates).
-- ---------------------------------------------------------------------------
create table if not exists public.notices (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('system', 'message')),
  key text unique check (char_length(key) <= 200),
  from_member uuid references public.members (id) on delete set null,
  to_members uuid[] not null default '{}',
  title text not null check (char_length(title) between 1 and 100),
  body text not null default '' check (char_length(body) <= 1000),
  url text check (char_length(url) <= 300),
  deliver_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notices_deliver_at_idx on public.notices (deliver_at);
create table if not exists public.notice_reads (
  notice_id uuid not null references public.notices (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notice_id, member_id)
);
-- hidden: the person cleared it from their own list (2026-11-03)
alter table public.notice_reads add column if not exists hidden boolean not null default false;
do $$
declare
  t text;
begin
  foreach t in array array['notices', 'notice_reads'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('grant select, insert, delete on public.%I to authenticated', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('drop policy if exists member_insert on public.%I', t);
    execute format('drop policy if exists member_delete on public.%I', t);
    execute format('drop policy if exists member_update on public.%I', t);
  end loop;
end;
$$;
grant update on public.notice_reads to authenticated;
-- everyone sees what was delivered; the sender also sees their scheduled messages
create policy member_read on public.notices for select to authenticated
  using (public.is_member() and (deliver_at <= now() or from_member = public.current_member_id()));
-- people only write messages, as themselves; system notices come from the job, and from administrators
-- when a bank statement import finds a low balance
create policy member_insert on public.notices for insert to authenticated
  with check (public.is_member() and (
    (kind = 'message' and from_member = public.current_member_id() and delivered_at is null)
    or (kind = 'system' and from_member is null and public.is_admin())));
-- a scheduled message can be cancelled by its sender until it is delivered
create policy member_delete on public.notices for delete to authenticated
  using (public.is_member() and kind = 'message' and from_member = public.current_member_id() and delivered_at is null);
-- read marks: everyone's are visible; each person adds and removes only their own
create policy member_read on public.notice_reads for select to authenticated using (public.is_member());
create policy member_insert on public.notice_reads for insert to authenticated
  with check (public.is_member() and member_id = public.current_member_id());
create policy member_delete on public.notice_reads for delete to authenticated
  using (public.is_member() and member_id = public.current_member_id());
create policy member_update on public.notice_reads for update to authenticated
  using (public.is_member() and member_id = public.current_member_id())
  with check (public.is_member() and member_id = public.current_member_id());

-- ---------------------------------------------------------------------------
-- 変更の通知と確認 (2026-11-03): a change of the budget, the ratios, the base amounts or the records of the
-- people (調整・立替・入金) becomes an お知らせ of kind 'change' for everyone, made here so that changes
-- made with SQL are not missed. Changes by the same person to the same thing within 10 minutes are one
-- お知らせ (a new line is added and everyone is asked again). Each person confirms it (acked_at); the job
-- reminds those who have not, once a day.
-- ---------------------------------------------------------------------------
alter table public.notices add column if not exists needs_ack boolean not null default false;
alter table public.notices drop constraint if exists notices_kind_check;
alter table public.notices add constraint notices_kind_check check (kind in ('system', 'message', 'change'));
alter table public.notice_reads add column if not exists acked_at timestamptz;

create or replace function public.yen_text(v bigint)
returns text language sql immutable set search_path = public as $$
  select case when v < 0 then '−' else '' end || to_char(abs(v), 'FM999,999,999,990') || '円';
$$;
create or replace function public.ym_text(ym text)
returns text language sql immutable set search_path = public as $$
  select case when ym is null then '' else split_part(ym, '-', 1) || '年' || ltrim(split_part(ym, '-', 2), '0') || '月' end;
$$;
create or replace function public.member_label(p uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nickname, name) from public.members where id = p), '（削除済み）');
$$;
-- the same for a key of a jsonb object (normally a member id)
create or replace function public.member_key_label(k text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select coalesce(nickname, name) from public.members where id::text = k), k);
$$;
-- {category or subcategory} {person} {percent}%・… of a category_ratios array
create or replace function public.category_ratios_text(v jsonb)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(string_agg(coalesce(nullif(r ->> 'subcategory', ''), r ->> 'category') || ' '
    || (select string_agg(public.member_key_label(e.key) || ' ' || e.value || '%', '・' order by e.value::numeric desc) from jsonb_each_text(r -> 'ratio') e)
    || coalesce('（' || public.ym_text(r ->> 'from') || 'から）', ''), '、'), 'なし')
  from jsonb_array_elements(coalesce(v, '[]'::jsonb)) r;
$$;

create or replace function public.record_change(p_group text, p_year integer, p_title text, p_url text, p_line text)
returns void language plpgsql security definer set search_path = public as $$
declare
  actor uuid := public.current_member_id();
  k text := format('change:%s:%s:%s:%s', p_group, coalesce(p_year::text, '-'), coalesce(actor::text, 'app'), floor(extract(epoch from now()) / 600)::bigint);
  nid uuid;
begin
  if p_line is null or p_line = '' then return; end if;
  insert into public.notices (kind, key, from_member, to_members, title, body, url, needs_ack, deliver_at)
  values ('change', k, actor, '{}', left(p_title, 100), left(p_line, 1000), p_url, true, now())
  on conflict (key) do update
    set body = left(public.notices.body || E'\n' || excluded.body, 1000), delivered_at = null, deliver_at = now()
  returning id into nid;
  delete from public.notice_reads where notice_id = nid; -- asked again: unread and not confirmed
end;
$$;

create or replace function public.budgets_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  y integer;
  line text;
begin
  if tg_op = 'INSERT' then
    y := new.year; line := format('費目「%s」の予算 月%s（新規）', new.category, public.yen_text(new.monthly));
  elsif tg_op = 'DELETE' then
    y := old.year; line := format('費目「%s」の予算 月%s（削除）', old.category, public.yen_text(old.monthly));
  else
    if new.monthly is not distinct from old.monthly and new.category = old.category then return null; end if;
    y := new.year; line := format('費目「%s」の予算 月%s → %s', new.category, public.yen_text(old.monthly), public.yen_text(new.monthly));
  end if;
  perform public.record_change('budget', y, format('%s年の予算・負担率が変わりました', y), format('#/flow/budget/%s', y), line);
  return null;
end;
$$;

create or replace function public.budget_years_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  lines text[] := '{}';
  wage text;
begin
  if tg_op = 'DELETE' then
    perform public.record_change('budget', old.year, format('%s年の予算・負担率が変わりました', old.year), format('#/flow/budget/%s', old.year), format('%s年の予算・負担率を削除', old.year));
    return null;
  end if;
  if tg_op = 'INSERT' or new.income_monthly is distinct from old.income_monthly then
    lines := lines || format('二人の負担額の合計 月%s', case when tg_op = 'INSERT' or old.income_monthly is null then coalesce(public.yen_text(new.income_monthly), '未設定')
      else public.yen_text(old.income_monthly) || ' → ' || coalesce(public.yen_text(new.income_monthly), '未設定') end);
  end if;
  if tg_op = 'INSERT' or new.ratio is distinct from old.ratio then
    select string_agg(public.member_key_label(k) || ' ' || coalesce(case when tg_op = 'UPDATE' then old.ratio ->> k end || ' → ', '') || coalesce(new.ratio ->> k, 'なし'), '・')
      into wage
      from (select jsonb_object_keys(coalesce(new.ratio, '{}'::jsonb)) k union select jsonb_object_keys(case when tg_op = 'UPDATE' then coalesce(old.ratio, '{}'::jsonb) else '{}'::jsonb end)) ks;
    if wage is not null then lines := lines || ('負担率のもとの値（賃金・千円）：' || wage); end if;
  end if;
  if (tg_op = 'INSERT' and jsonb_array_length(coalesce(new.category_ratios, '[]'::jsonb)) > 0)
     or (tg_op = 'UPDATE' and new.category_ratios is distinct from old.category_ratios) then
    lines := lines || ('費目ごとの負担率：' || public.category_ratios_text(new.category_ratios));
  end if;
  if array_length(lines, 1) is null then return null; end if;
  perform public.record_change('budget', new.year, format('%s年の予算・負担率が変わりました', new.year), format('#/flow/budget/%s', new.year), array_to_string(lines, E'\n'));
  return null;
end;
$$;

-- each person's base amount (基本 and other rules not tied to a contract)
create or replace function public.shared_rules_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r public.shared_rules := coalesce(new, old);
  period text;
  line text;
  y integer;
begin
  if r.contract_id is not null then return null; end if;
  y := split_part(case when tg_op = 'DELETE' then old.start_ym else new.start_ym end, '-', 1)::integer;
  period := public.ym_text(r.start_ym) || '〜' || coalesce(public.ym_text(r.end_ym), '');
  if tg_op = 'INSERT' then
    line := format('%sの%s 月%s（%s）', public.member_label(new.member_id), new.label, public.yen_text(new.amount), period);
  elsif tg_op = 'DELETE' then
    line := format('%sの%s 月%s（%s）を削除', public.member_label(old.member_id), old.label, public.yen_text(old.amount), period);
  else
    if new.amount = old.amount and new.start_ym = old.start_ym and new.end_ym is not distinct from old.end_ym and new.label = old.label and new.member_id = old.member_id then return null; end if;
    line := format('%sの%s 月%s（%s〜%s） → 月%s（%s）', public.member_label(new.member_id), new.label, public.yen_text(old.amount),
      public.ym_text(old.start_ym), coalesce(public.ym_text(old.end_ym), ''), public.yen_text(new.amount), period);
  end if;
  perform public.record_change('budget', y, format('%s年の予算・負担率が変わりました', y), format('#/flow/budget/%s', y), line);
  return null;
end;
$$;

-- the records of the people: 調整, 立替 / 臨時の費目, 入金
create or replace function public.shared_entry_text(e public.shared_entries)
returns text language sql stable security definer set search_path = public as $$
  select format('%s %s %s「%s」 %s%s', public.member_label(e.member_id), public.ym_text(e.ym),
    case e.kind when 'deposit' then '入金' when 'adjust' then '調整' else case when e.amount < 0 then '立替' else '臨時の費目' end end,
    e.label, public.yen_text(e.amount), coalesce('（' || left(nullif(e.memo, ''), 40) || case when char_length(e.memo) > 40 then '…' else '' end || '）', ''));
$$;
create or replace function public.shared_entries_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  line text;
  y integer;
  ym text;
begin
  if tg_op = 'INSERT' then
    line := '追加：' || public.shared_entry_text(new); ym := new.ym;
  elsif tg_op = 'DELETE' then
    line := '削除：' || public.shared_entry_text(old); ym := old.ym;
  else
    if new.amount = old.amount and new.label = old.label and new.ym = old.ym and new.kind = old.kind and new.member_id = old.member_id
       and new.memo is not distinct from old.memo then return null; end if;
    line := '変更：' || public.shared_entry_text(old) || ' → ' || public.shared_entry_text(new); ym := new.ym;
  end if;
  y := split_part(ym, '-', 1)::integer;
  perform public.record_change('entries', y, '個人の入金・立替の記録が変わりました', format('#/flow/member/%s', ym), line);
  return null;
end;
$$;

-- 入金の報告 (a person says they paid, before the statement shows it): everyone confirms it too
create or replace function public.deposit_reports_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r public.deposit_reports := coalesce(new, old);
  txt text;
  line text;
begin
  txt := format('%s %s %s%s', public.member_label(r.member_id), to_char(r.paid_on, 'FMMM/FMDD'), public.yen_text(r.amount),
    coalesce('（' || left(nullif(r.memo, ''), 40) || case when char_length(r.memo) > 40 then '…' else '' end || '）', ''));
  if tg_op = 'INSERT' then
    line := '報告：' || txt;
  elsif tg_op = 'DELETE' then
    line := '取り消し：' || txt;
  else
    if new.amount = old.amount and new.paid_on = old.paid_on and new.member_id = old.member_id and new.memo is not distinct from old.memo then return null; end if;
    line := format('変更：%s %s %s → %s %s', public.member_label(old.member_id), to_char(old.paid_on, 'FMMM/FMDD'), public.yen_text(old.amount),
      to_char(new.paid_on, 'FMMM/FMDD'), public.yen_text(new.amount));
  end if;
  perform public.record_change('reports', extract(year from r.paid_on)::integer, '入金の報告がありました', '#/flow/member', line);
  return null;
end;
$$;

revoke all on function public.record_change(text, integer, text, text, text) from public, anon, authenticated;
do $$
declare
  t text;
begin
  foreach t in array array['budgets', 'budget_years', 'shared_rules', 'shared_entries', 'deposit_reports'] loop
    execute format('drop trigger if exists %I_notify on public.%I', t, t);
    execute format('create trigger %I_notify after insert or update or delete on public.%I for each row execute function public.%I_changed()', t, t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Removal of the single-owner version. Run this section only after logging in with the new
-- version has been confirmed (on a new project it does nothing).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships'] loop
    execute format('alter table public.%I drop column if exists holder', t);
  end loop;
end;
$$;
delete from public.settings where key = 'members';
drop function if exists public.is_app_owner();
drop table if exists public.app_owner;
