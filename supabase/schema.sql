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
  kind text not null check (kind in ('charge', 'deposit')),
  label text not null check (char_length(label) between 1 and 50),
  amount integer not null check (amount between -100000000 and 100000000 and amount <> 0),
  memo text check (char_length(memo) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.members (id) on delete set null,
  updated_by uuid references public.members (id) on delete set null,
  check (kind = 'charge' or amount > 0)
);
create index if not exists shared_entries_member_ym_idx on public.shared_entries (member_id, ym);

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

-- ---------------------------------------------------------------------------
-- Triggers, privileges and row level security
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships', 'chores', 'shared_rules', 'shared_entries'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('drop trigger if exists %I_stamp on public.%I', t, t);
    execute format('create trigger %I_stamp before insert or update on public.%I for each row execute function public.stamp_row()', t, t);
  end loop;
  execute 'drop trigger if exists item_photos_stamp on public.item_photos';
  execute 'create trigger item_photos_stamp before insert or update on public.item_photos for each row execute function public.stamp_row()';
  foreach t in array array['settings', 'members'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships', 'item_photos', 'members', 'chores', 'shared_rules', 'shared_entries'] loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.audit_row()', t, t);
  end loop;
  execute 'drop trigger if exists members_guard_last_admin on public.members';
  execute 'create trigger members_guard_last_admin after update or delete on public.members for each statement execute function public.guard_last_admin()';

  foreach t in array array['members', 'accounts', 'cards', 'contracts', 'items', 'memberships',
                           'item_photos', 'settings', 'push_subscriptions', 'notification_log', 'audit_log', 'chores', 'shared_rules', 'shared_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    -- service_role (used only by the daily GitHub Actions job) bypasses RLS but still needs table
    -- privileges when "Automatically expose new tables" is off for the project.
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('drop policy if exists owner_all on public.%I', t);
  end loop;

  -- household data: every active member can read and write
  foreach t in array array['accounts', 'cards', 'contracts', 'items', 'memberships', 'item_photos', 'push_subscriptions', 'chores', 'shared_rules', 'shared_entries'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists member_all on public.%I', t);
    execute format('create policy member_all on public.%I for all to authenticated using (public.is_member()) with check (public.is_member())', t);
  end loop;

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
