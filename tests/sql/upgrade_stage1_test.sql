-- After the new parts are added (old parts still present): migration result + the old app keeps working.
\set ON_ERROR_STOP on
do $$ begin
  if (select count(*) from public.members where name = '共通（管理者）' and email = 'owner@example.com' and role = 'admin' and active) <> 1 then
    raise exception 'former owner is not the first administrator';
  end if;
  if (select count(*) from public.members where name in ('筒井 春香', '山田 花子', '別名 太郎') and email is null) <> 3 then
    raise exception 'family names / holders were not migrated';
  end if;
  if (select m.name from public.accounts a join public.members m on m.id = a.holder_id where a.name = 'upgrade-survivor') <> '筒井 春香' then
    raise exception 'account holder not linked';
  end if;
  if (select m.name from public.cards c join public.members m on m.id = c.holder_id) <> '別名 太郎' then
    raise exception 'card holder not linked';
  end if;
  if to_regclass('public.app_owner') is null then raise exception 'stage 1 removed app_owner too early'; end if;
end $$;
-- the old app (free-text holder, logged in as the former owner) can still read and write
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false),
       set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"owner@example.com"}', false);
insert into public.accounts (name, holder) values ('旧アプリから追加', '筒井 春香');
do $$ begin
  if (select count(*) from public.accounts) <> 2 then raise exception 'former owner cannot read accounts'; end if;
end $$;
reset role;
delete from public.accounts where name = '旧アプリから追加';
