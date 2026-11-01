-- Access control, stamps and change history on a new project. Every failed check raises an exception.
\set ON_ERROR_STOP on

-- switch the logged-in user (email = null: no login, e.g. the Supabase MCP / SQL editor)
create function pg_temp.login(p_email text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(md5(p_email)::uuid::text, ''), false),
         set_config('request.jwt.claims', case when p_email is null then '' else
           json_build_object('sub', md5(p_email)::uuid, 'email', p_email)::text end, false);
$$;

insert into public.members (name, email, role, active) values
  ('共通（管理者）', 'owner@example.com', 'admin', true),
  ('佐藤 春子', 'member@example.com', 'member', true),
  ('退会者', 'old@example.com', 'member', false),
  ('子ども', null, 'member', true);
insert into storage.objects (bucket_id, name, metadata) values ('item-photos', 'x/a.jpg', '{"size": 1234}');

-- a member can read and write household data; who created it is recorded
set role authenticated;
select pg_temp.login('member@example.com');
insert into public.accounts (name, account_no, last4, holder_id)
  select '生活費口座', '0001234', '1234', id from public.members where name = '子ども';
do $$ begin
  if (select count(*) from public.accounts) <> 1 then raise exception 'member cannot read accounts'; end if;
  if (select created_by from public.accounts) is distinct from (select id from public.members where name = '佐藤 春子') then
    raise exception 'created_by not stamped';
  end if;
  if (select count(*) from public.members) <> 4 then raise exception 'member cannot read the user master'; end if;
  if (select count(*) from storage.objects) <> 1 then raise exception 'member cannot read photos'; end if;
  if ((public.usage_stats() ->> 'storage_bytes')::bigint) <> 1234 then raise exception 'usage_stats wrong'; end if;
  if not public.is_member() or public.is_admin() then raise exception 'member role detection wrong'; end if;
end $$;

-- a member cannot change the user master or the administrator settings
do $$ begin
  begin insert into public.members (name) values ('勝手に追加'); raise exception 'member added a member';
  exception when insufficient_privilege then null; end;
  update public.members set role = 'admin' where name = '佐藤 春子';
  if (select role from public.members where name = '佐藤 春子') <> 'member' then raise exception 'member promoted self'; end if;
  begin insert into public.settings (key, value) values ('shortcuts', '[]'); raise exception 'member changed shortcuts';
  exception when insufficient_privilege then null; end;
  insert into public.settings (key, value) values ('last_backup_at', '"2026-11-01T00:00:00Z"');
end $$;

-- history: changes are recorded with the actor; the full account number is masked; no-op updates are skipped
update public.accounts set bank_code = '0036', account_no = '0005678', last4 = '5678';
update public.accounts set bank_code = '0036';
do $$
declare
  h public.audit_log;
begin
  if (select count(*) from public.audit_log where table_name = 'accounts') <> 2 then raise exception 'history count wrong'; end if;
  select * into h from public.audit_log where action = 'update';
  if h.actor_name <> '佐藤 春子' or h.record_name <> '生活費口座' then raise exception 'history actor/record wrong'; end if;
  if h.changes <> '{"bank_code": [null, "0036"], "account_no": ["●●●1234", "●●●5678"]}'::jsonb then
    raise exception 'history changes wrong: %', h.changes;
  end if;
  if h.changes::text like '%0005678%' or h.changes::text like '%0001234%' then raise exception 'full account number leaked into history'; end if;
  begin insert into public.audit_log (table_name, record_id, action, actor_name) values ('accounts', gen_random_uuid(), 'insert', 'x');
    raise exception 'member wrote history';
  exception when insufficient_privilege then null; end;
  begin update public.audit_log set actor_name = 'x'; raise exception 'member edited history';
  exception when insufficient_privilege then null; end;
  begin delete from public.audit_log; raise exception 'member deleted history';
  exception when insufficient_privilege then null; end;
end $$;

-- photos are recorded on the item
insert into public.items (id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '冷蔵庫');
insert into public.item_photos (item_id, path, thumb_path) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'p.jpg', 'p_t.jpg');
do $$ begin
  if (select count(*) from public.audit_log where table_name = 'items' and record_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and action = 'photo_insert') <> 1 then
    raise exception 'photo not recorded on the item';
  end if;
end $$;

-- an administrator: updated_by changes, created_by stays; settings and user master are writable
select pg_temp.login('owner@example.com');
update public.accounts set purpose = '生活費';
do $$ begin
  if (select updated_by from public.accounts) is distinct from (select id from public.members where name = '共通（管理者）') then raise exception 'updated_by wrong'; end if;
  if (select created_by from public.accounts) is distinct from (select id from public.members where name = '佐藤 春子') then raise exception 'created_by changed'; end if;
  if not public.is_admin() then raise exception 'admin not detected'; end if;
end $$;
insert into public.settings (key, value) values ('shortcuts', '[]');
insert into public.members (name) values ('祖母');

-- at least one active administrator with a login must remain
do $$ begin
  begin update public.members set role = 'member' where email = 'owner@example.com'; raise exception 'last admin demoted';
  exception when sqlstate 'HH001' then null; end;
  begin update public.members set active = false where email = 'owner@example.com'; raise exception 'last admin deactivated';
  exception when sqlstate 'HH001' then null; end;
end $$;
update public.members set role = 'admin' where name = '佐藤 春子';
update public.members set role = 'member' where email = 'owner@example.com';
do $$ begin
  if (select role from public.members where email = 'owner@example.com') <> 'member' then raise exception 'demotion with another admin failed'; end if;
end $$;
select pg_temp.login('member@example.com');
update public.members set role = 'admin' where email = 'owner@example.com';
select pg_temp.login('owner@example.com');

-- deleting a member clears holder links and is recorded
delete from public.members where name = '子ども';
do $$ begin
  if (select holder_id from public.accounts) is not null then raise exception 'holder link not cleared'; end if;
  if (select count(*) from public.audit_log where table_name = 'members' and action = 'delete' and record_name = '子ども') <> 1 then
    raise exception 'member deletion not recorded';
  end if;
end $$;

-- invalid values are rejected
do $$ begin
  begin insert into public.cards (name, last4) values ('x', '12345'); raise exception 'last4 accepted 5 digits';
  exception when check_violation then null; end;
  begin insert into public.items (name, manual_url) values ('x', 'javascript:alert(1)'); raise exception 'bad url accepted';
  exception when check_violation then null; end;
  insert into public.cards (name) values ('支払確認用カード');
  begin insert into public.contracts (name, pay_card_id, pay_account_id)
    select 'x', c.id, a.id from public.cards c, public.accounts a limit 1;
    raise exception 'two payment methods accepted';
  exception when check_violation then null; end;
  begin insert into public.accounts (name, bank_code) values ('x', '36'); raise exception 'short bank_code accepted';
  exception when check_violation then null; end;
  begin insert into public.accounts (name, branch_code) values ('x', '2250'); raise exception 'long branch_code accepted';
  exception when check_violation then null; end;
  begin insert into public.accounts (name, account_no) values ('x', '123-4567'); raise exception 'non-digit account_no accepted';
  exception when check_violation then null; end;
  begin insert into public.members (name, email) values ('大文字', 'Upper@Example.com'); raise exception 'uppercase email accepted';
  exception when check_violation then null; end;
end $$;

-- inactive members and other logged-in users see nothing and cannot write
do $$
declare
  e text;
begin
  foreach e in array array['old@example.com', 'stranger@example.com'] loop
    perform pg_temp.login(e);
    if (select count(*) from public.accounts) <> 0 then raise exception '% can read accounts', e; end if;
    if (select count(*) from public.members) <> 0 then raise exception '% can read the user master', e; end if;
    if (select count(*) from public.audit_log) <> 0 then raise exception '% can read the history', e; end if;
    if (select count(*) from storage.objects) <> 0 then raise exception '% can read photos', e; end if;
    begin insert into public.accounts (name) values ('hack'); raise exception '% can insert', e;
    exception when insufficient_privilege then null; end;
    begin perform public.usage_stats(); raise exception '% can call usage_stats', e;
    exception when insufficient_privilege then null; end;
  end loop;
end $$;

-- internal tables are not readable through the API role
select pg_temp.login('owner@example.com');
do $$ begin
  begin perform * from public.notification_log; raise exception 'notification_log readable';
  exception when insufficient_privilege then null; end;
end $$;

-- shared account: administrators record rules and deposits; a member only their own one-off items (立替)
reset role;
insert into public.members (name, email, role, active) values ('立替する人', 'adv@example.com', 'member', true), ('見るだけの人', 'view@example.com', 'member', true);
set role authenticated;
select pg_temp.login('owner@example.com');
insert into public.shared_rules (member_id, label, amount, start_ym)
  select id, '基本', 80000, '2026-01' from public.members where name = '佐藤 春子';
insert into public.shared_entries (member_id, ym, kind, label, amount)
  select id, '2026-02', 'deposit', '入金', 150000 from public.members where name = '佐藤 春子';
insert into public.shared_entries (member_id, ym, kind, label, amount)
  select id, '2026-02', 'charge', '管理費', -3000 from public.members where name = '祖母';
select pg_temp.login('adv@example.com');
insert into public.shared_entries (member_id, ym, kind, label, amount)
  select id, '2026-03', 'charge', '立替', -2500 from public.members where name = '立替する人';
do $$ begin
  if (select count(*) from public.shared_rules) <> 1 or (select count(*) from public.shared_entries) <> 3 then
    raise exception 'member cannot read or record the shared account';
  end if;
  if (select record_name from public.audit_log where table_name = 'shared_rules' and action = 'insert') <> '基本' then
    raise exception 'shared rule history has no label';
  end if;
  -- own one-off items can be changed and deleted
  update public.shared_entries set amount = -2600 where label = '立替';
  if (select amount from public.shared_entries where label = '立替') <> -2600 then raise exception 'member cannot change own item'; end if;
  -- not deposits, not other people's records, not manual recurring items
  begin insert into public.shared_entries (member_id, ym, kind, label, amount) select id, '2026-03', 'deposit', '入金', 1 from public.members where name = '立替する人';
    raise exception 'member recorded a deposit'; exception when insufficient_privilege then null; end;
  begin insert into public.shared_entries (member_id, ym, kind, label, amount) select id, '2026-03', 'charge', '立替', -1 from public.members where name = '祖母';
    raise exception 'member recorded for someone else'; exception when insufficient_privilege then null; end;
  update public.shared_entries set amount = -1 where label = '管理費';
  delete from public.shared_entries where label = '管理費';
  update public.shared_entries set amount = 1 where kind = 'deposit';
  if (select amount from public.shared_entries where label = '管理費') <> -3000 or (select amount from public.shared_entries where kind = 'deposit') <> 150000 then
    raise exception 'member changed a record that is not theirs';
  end if;
  begin update public.shared_entries set member_id = (select id from public.members where name = '祖母') where label = '立替';
    raise exception 'member moved own item to someone else'; exception when insufficient_privilege then null; end;
  begin insert into public.shared_rules (member_id, label, amount, start_ym) select id, 'x', 1, '2026-05' from public.members limit 1;
    raise exception 'member added a recurring item'; exception when insufficient_privilege then null; end;
  update public.shared_rules set amount = 1;
  delete from public.shared_rules;
  if (select amount from public.shared_rules) <> 80000 then raise exception 'member changed a recurring item'; end if;
  delete from public.shared_entries where label = '立替';
  if (select count(*) from public.shared_entries) <> 2 then raise exception 'member cannot delete own item'; end if;
end $$;
select pg_temp.login('owner@example.com');
do $$ begin
  begin insert into public.shared_entries (member_id, ym, kind, label, amount) select id, '2026-02', 'deposit', '入金', -1 from public.members limit 1;
    raise exception 'negative deposit accepted'; exception when check_violation then null; end;
  begin insert into public.shared_entries (member_id, ym, kind, label, amount) select id, '2026-13', 'charge', 'x', 1 from public.members limit 1;
    raise exception 'bad month accepted'; exception when check_violation then null; end;
  begin insert into public.shared_rules (member_id, label, amount, start_ym, end_ym) select id, 'x', 1, '2026-05', '2026-04' from public.members limit 1;
    raise exception 'end before start accepted'; exception when check_violation then null; end;
  begin insert into public.shared_rules (member_id, label, amount, start_ym) select id, 'x', 0, '2026-05' from public.members limit 1;
    raise exception 'zero amount accepted'; exception when check_violation then null; end;
end $$;
-- each person sets only their own notification hour
select pg_temp.login('adv@example.com');
select public.set_my_notify_hour(21);
do $$ begin
  if (select notify_hour from public.members where name = '立替する人') <> 21 then raise exception 'own notify hour not set'; end if;
  if (select count(*) from public.members where notify_hour is not null) <> 1 then raise exception 'someone else''s hour changed'; end if;
  begin perform public.set_my_notify_hour(24); raise exception 'hour 24 accepted'; exception when invalid_parameter_value then null; end;
end $$;

-- 立替 by date with a receipt, deposit reports: a member writes only their own
select pg_temp.login('adv@example.com');
insert into public.shared_entries (member_id, ym, kind, label, amount, paid_on)
  select id, '2026-04', 'charge', '立替', -1500, '2026-04-12' from public.members where name = '立替する人';
insert into public.shared_attachments (entry_id, path, thumb_path)
  select id, 'receipts/a.jpg', 'receipts/a_t.jpg' from public.shared_entries where paid_on = '2026-04-12';
insert into public.deposit_reports (member_id, paid_on, amount) select id, '2026-04-25', 80000 from public.members where name = '立替する人';
insert into public.shared_attachments (report_id, path, thumb_path) select id, 'reports/a.jpg', 'reports/a_t.jpg' from public.deposit_reports;
do $$ begin
  if (select count(*) from public.shared_attachments) <> 2 then raise exception 'member cannot attach to own records'; end if;
  if (select created_by from public.deposit_reports) is null then raise exception 'deposit report not stamped'; end if;
  begin insert into public.deposit_reports (member_id, paid_on, amount) select id, '2026-04-25', 1 from public.members where name = '祖母';
    raise exception 'member reported for someone else'; exception when insufficient_privilege then null; end;
  begin insert into public.shared_attachments (entry_id, path, thumb_path) select id, 'x.jpg', 'x_t.jpg' from public.shared_entries where label = '管理費';
    raise exception 'member attached to someone else''s item'; exception when insufficient_privilege then null; end;
  begin insert into public.deposit_reports (member_id, paid_on, amount) select id, '2026-04-25', 0 from public.members where name = '立替する人';
    raise exception 'zero report accepted'; exception when check_violation then null; end;
  begin insert into public.shared_attachments (path, thumb_path) values ('y.jpg', 'y_t.jpg');
    raise exception 'attachment without a record accepted'; exception when check_violation or insufficient_privilege then null; end;
end $$;
select pg_temp.login('view@example.com');
do $$ begin
  if (select count(*) from public.deposit_reports) <> 1 or (select count(*) from public.shared_attachments) <> 2 then raise exception 'others cannot see reports'; end if;
  delete from public.deposit_reports;
  delete from public.shared_attachments;
  if (select count(*) from public.deposit_reports) <> 1 or (select count(*) from public.shared_attachments) <> 2 then raise exception 'member deleted someone else''s report'; end if;
end $$;
select pg_temp.login('adv@example.com');
delete from public.shared_entries where paid_on = '2026-04-12';
delete from public.deposit_reports;
do $$ begin
  if (select count(*) from public.shared_attachments) <> 0 then raise exception 'attachments not removed with their record'; end if;
end $$;

select pg_temp.login('owner@example.com');
do $$ begin
  begin delete from public.members where name = '佐藤 春子'; raise exception 'member with shared records deleted';
  exception when foreign_key_violation then null; end;
end $$;
select pg_temp.login('stranger@example.com');
do $$ begin
  if (select count(*) from public.shared_entries) <> 0 then raise exception 'stranger can read the shared account'; end if;
end $$;
-- a rule kept for a contract: yearly month, link cleared (history kept) when the contract is deleted
select pg_temp.login('member@example.com');
insert into public.contracts (name, amount, cycle, shared_cost) values ('テスト保険', 20000, 'yearly', true);
insert into public.shared_rules (member_id, label, amount, start_ym, month_of_year, contract_id)
  select (select id from public.members where name = '佐藤 春子'), 'テスト保険', -20000, '2026-01', 5, id from public.contracts where name = 'テスト保険';
do $$ begin
  if not (select shared_cost from public.contracts where name = 'テスト保険') then raise exception 'shared_cost not stored'; end if;
  begin insert into public.shared_rules (member_id, label, amount, start_ym, month_of_year) select id, 'x', -1, '2026-01', 13 from public.members limit 1;
    raise exception 'bad month_of_year accepted'; exception when check_violation then null; end;
end $$;
delete from public.contracts where name = 'テスト保険';
do $$ begin
  if (select count(*) from public.shared_rules where label = 'テスト保険' and contract_id is null) <> 1 then
    raise exception 'rule lost or still linked after the contract was deleted';
  end if;
end $$;
select pg_temp.login('owner@example.com');
delete from public.shared_entries;
delete from public.shared_rules;
select pg_temp.login('member@example.com');

-- MoneyForward statement lines: members read/write, one row per MoneyForward ID, strangers see nothing
select pg_temp.login('member@example.com');
insert into public.transactions (mf_id, date, description, amount, institution) values ('mf-1', '2026-10-02', 'サンプル電力', -8000, '共用口座');
do $$ begin
  begin insert into public.transactions (mf_id, date, description, amount) values ('mf-1', '2026-10-03', 'x', -1);
    raise exception 'duplicate MoneyForward ID accepted'; exception when unique_violation then null; end;
  if (select created_by from public.transactions where mf_id = 'mf-1') is null then raise exception 'transaction not stamped'; end if;
  if exists (select 1 from public.audit_log where table_name = 'transactions') then raise exception 'statement lines must not fill the history'; end if;
end $$;
-- personal lines: settled by a one-off charge; deleting the charge puts the line back to pending
insert into public.shared_entries (member_id, ym, kind, label, amount)
  select id, '2026-10', 'charge', '個人負担の精算（1件）', 8000 from public.members where name = '佐藤 春子';
update public.transactions set personal_member_id = (select id from public.members where name = '佐藤 春子'), needs_review = false,
  settled_entry_id = (select id from public.shared_entries where label = '個人負担の精算（1件）') where mf_id = 'mf-1';
delete from public.shared_entries where label = '個人負担の精算（1件）';
do $$ begin
  if (select settled_entry_id from public.transactions where mf_id = 'mf-1') is not null then raise exception 'settlement link kept after the charge was deleted'; end if;
  if (select personal_member_id from public.transactions where mf_id = 'mf-1') is null then raise exception 'personal owner lost'; end if;
end $$;
update public.accounts set mf_name = '共用口座' where false;
update public.contracts set match_keywords = 'サンプル電力' where false;
select pg_temp.login('stranger@example.com');
do $$ begin
  if (select count(*) from public.transactions) <> 0 then raise exception 'stranger can read the statement'; end if;
end $$;
select pg_temp.login('member@example.com');
delete from public.transactions;

-- card type: only the listed values
select pg_temp.login('member@example.com');
insert into public.cards (name, kind, brand, last4) values ('テストデビット', 'デビット', 'VISA', '0001');
do $$ begin
  begin insert into public.cards (name, kind) values ('x', 'ポイント'); raise exception 'bad card kind accepted';
  exception when check_violation then null; end;
end $$;
delete from public.cards where name = 'テストデビット';

-- nicknames (unique) are shown as the actor; chores follow the same access rules and history
select pg_temp.login('owner@example.com');
update public.members set nickname = 'はる' where name = '佐藤 春子';
do $$ begin
  begin update public.members set nickname = 'はる' where name = '祖母'; raise exception 'duplicate nickname accepted';
  exception when unique_violation then null; end;
end $$;
select pg_temp.login('member@example.com');
insert into public.chores (name, category, cycle, schedule, times, minutes, assignee_type, assignee_id)
  select 'ゴミ出し', '住', 'week', '[2, 5]', 2, 5, 'member', id from public.members where name = '佐藤 春子';
update public.chores set minutes = 10;
do $$ begin
  if (select count(*) from public.chores) <> 1 then raise exception 'member cannot read chores'; end if;
  if (select actor_name from public.audit_log where table_name = 'chores' and action = 'update') <> 'はる' then
    raise exception 'actor nickname not used in the history';
  end if;
  if (select created_by from public.chores) is distinct from (select id from public.members where name = '佐藤 春子') then
    raise exception 'chore not stamped';
  end if;
  begin insert into public.chores (name, cycle) values ('x', 'hour'); raise exception 'bad cycle accepted';
  exception when check_violation then null; end;
  begin insert into public.chores (name, adjust) values ('x', 0); raise exception 'zero adjust accepted';
  exception when check_violation then null; end;
end $$;
select pg_temp.login('stranger@example.com');
do $$ begin
  if (select count(*) from public.chores) <> 0 then raise exception 'stranger can read chores'; end if;
  begin insert into public.chores (name) values ('hack'); raise exception 'stranger can add chores';
  exception when insufficient_privilege then null; end;
end $$;

-- changes made without a login (Supabase MCP / SQL editor) are recorded as the admin tool
reset role;
select pg_temp.login(null);
update public.accounts set memo = 'メモ';
do $$ begin
  if (select actor_name from public.audit_log order by id desc limit 1) <> '管理ツール' then raise exception 'tool actor wrong'; end if;
  if (select updated_by from public.accounts) is not null then raise exception 'tool change stamped as a member'; end if;
end $$;

-- the daily notification job (service_role) can do everything scripts/notify.mjs needs
set role service_role;
do $$ begin
  perform * from public.settings;
  perform * from public.push_subscriptions;
  perform * from public.cards;
  perform * from public.contracts;
  perform * from public.items;
  perform * from public.chores;
  perform * from public.members;
  perform * from public.notification_log;
  insert into public.notification_log (key) values ('test:key');
  delete from public.notification_log where key = 'test:key';
  delete from public.push_subscriptions where id = gen_random_uuid();
end $$;

-- anonymous users get nothing
reset role;
set role anon;
do $$ begin
  begin perform * from public.accounts; raise exception 'anon can read accounts';
  exception when insufficient_privilege then null; end;
  begin perform * from public.members; raise exception 'anon can read members';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  if to_regclass('public.app_owner') is not null then raise exception 'new project has app_owner'; end if;
end $$;
select 'RLS tests passed' as result;
