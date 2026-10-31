-- RLS checks. Every failed check raises an exception.
\set ON_ERROR_STOP on
-- data created before the upgrade survived it, and the new columns exist
do $$ begin
  if (select count(*) from public.accounts where name = 'upgrade-survivor' and last4 = '9999' and bank_code is null and branch_code is null) <> 1 then
    raise exception 'row lost or new columns missing after upgrade';
  end if;
end $$;
delete from public.accounts where name = 'upgrade-survivor';

insert into auth.users values ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
                              ('22222222-2222-2222-2222-222222222222', 'other@example.com');
insert into public.app_owner (user_id)
  select id from auth.users where email = 'owner@example.com'
  on conflict (singleton) do update set user_id = excluded.user_id;
insert into storage.objects (bucket_id, name, metadata) values ('item-photos', 'x/a.jpg', '{"size": 1234}');

-- owner can write and read
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
insert into public.accounts (name, last4) values ('生活費口座', '1234');
insert into public.cards (name, debit_account_id, expiry_ym)
  select 'メインカード', id, '2027-05' from public.accounts;
do $$ begin
  if (select count(*) from public.accounts) <> 1 then raise exception 'owner cannot read accounts'; end if;
  if (select count(*) from storage.objects) <> 1 then raise exception 'owner cannot read photos'; end if;
  if ((public.usage_stats() ->> 'storage_bytes')::bigint) <> 1234 then raise exception 'usage_stats wrong'; end if;
end $$;

-- invalid values are rejected
do $$ begin
  begin insert into public.accounts (name, last4) values ('x', '12345'); raise exception 'last4 accepted 5 digits';
  exception when check_violation then null; end;
  begin insert into public.items (name, manual_url) values ('x', 'javascript:alert(1)'); raise exception 'bad url accepted';
  exception when check_violation then null; end;
  begin insert into public.contracts (name, pay_card_id, pay_account_id)
    select 'x', c.id, a.id from public.cards c, public.accounts a; raise exception 'two payment methods accepted';
  exception when check_violation then null; end;
end $$;

do $$ begin
  insert into public.accounts (name, bank_code, branch_code) values ('コード付き口座', '0036', '225');
  begin insert into public.accounts (name, bank_code) values ('x', '36'); raise exception 'short bank_code accepted';
  exception when check_violation then null; end;
  begin insert into public.accounts (name, branch_code) values ('x', '2250'); raise exception 'long branch_code accepted';
  exception when check_violation then null; end;
  begin insert into public.accounts (name, bank_code) values ('x', '00a6'); raise exception 'non-digit bank_code accepted';
  exception when check_violation then null; end;
end $$;
delete from public.accounts where name = 'コード付き口座';

-- another logged-in user sees nothing and cannot write
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $$ begin
  if (select count(*) from public.accounts) <> 0 then raise exception 'other user can read accounts'; end if;
  if (select count(*) from public.cards) <> 0 then raise exception 'other user can read cards'; end if;
  if (select count(*) from storage.objects) <> 0 then raise exception 'other user can read photos'; end if;
  begin insert into public.accounts (name) values ('hack'); raise exception 'other user can insert';
  exception when insufficient_privilege then null; end;
  begin perform public.usage_stats(); raise exception 'other user can call usage_stats';
  exception when insufficient_privilege then null; end;
end $$;

-- owner cannot read the internal tables through the API role
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$ begin
  begin perform * from public.notification_log; raise exception 'notification_log readable';
  exception when insufficient_privilege then null; end;
  begin perform * from public.app_owner; raise exception 'app_owner readable';
  exception when insufficient_privilege then null; end;
end $$;

-- the daily notification job (service_role) can do everything scripts/notify.mjs needs
reset role;
set role service_role;
do $$ begin
  perform * from public.settings;
  perform * from public.push_subscriptions;
  perform * from public.cards;
  perform * from public.contracts;
  perform * from public.items;
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
end $$;
reset role;
select 'RLS tests passed' as result;
