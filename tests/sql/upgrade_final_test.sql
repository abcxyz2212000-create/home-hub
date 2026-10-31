-- After the old parts are removed.
\set ON_ERROR_STOP on
do $$ begin
  if to_regclass('public.app_owner') is not null then raise exception 'app_owner still exists'; end if;
  if exists (select 1 from pg_proc where proname = 'is_app_owner') then raise exception 'is_app_owner still exists'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and column_name = 'holder') then
    raise exception 'free-text holder column still exists';
  end if;
  if exists (select 1 from public.settings where key = 'members') then raise exception 'settings.members still exists'; end if;
  if (select count(*) from public.accounts where name = 'upgrade-survivor' and account_no = '0001234' and bank_code = '0036' and holder_id is not null) <> 1 then
    raise exception 'data lost in the upgrade';
  end if;
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false),
       set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"owner@example.com"}', false);
do $$ begin
  if (select count(*) from public.accounts) <> 1 then raise exception 'administrator cannot read accounts after the upgrade'; end if;
end $$;
reset role;
select 'upgrade tests passed' as result;
