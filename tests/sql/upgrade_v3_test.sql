-- After upgrading the production state: data kept, nickname column and chores table usable.
\set ON_ERROR_STOP on
update public.members set nickname = 'はる' where name = '佐藤 春子';
insert into public.members (name, nickname) values ('佐藤 真一', 'しん');
insert into public.chores (name, cycle, times, minutes, assignee_type, assignee_id)
  select 'トイレ掃除', 'month', 1, 15, 'member', id from public.members where nickname = 'しん';
do $$ begin
  if (select count(*) from public.accounts a join public.members m on m.id = a.holder_id
      where a.name = '楽天銀行' and a.account_no = '1234567' and m.name = '佐藤 春子' and m.nickname = 'はる') <> 1 then
    raise exception 'production data lost in the upgrade';
  end if;
  if (select count(*) from public.chores c join public.members m on m.id = c.assignee_id where m.nickname = 'しん') <> 1 then
    raise exception 'chores not usable after the upgrade';
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'cards' and column_name = 'kind') then
    raise exception 'cards.kind missing after the upgrade';
  end if;
  if (select count(*) from information_schema.columns where (table_name, column_name) in
      (('accounts', 'mf_name'), ('cards', 'mf_name'), ('contracts', 'match_keywords'), ('transactions', 'mf_id'),
       ('transactions', 'personal_member_id'), ('transactions', 'needs_review'), ('transactions', 'settled_entry_id'),
       ('members', 'transfer_names'), ('transactions', 'deposit_entry_id'), ('transactions', 'deposit_ignored'))) <> 10 then
    raise exception 'MoneyForward import columns missing after the upgrade';
  end if;
  if (select count(*) from information_schema.columns where (table_name, column_name) in
      (('contracts', 'shared_cost'), ('shared_rules', 'month_of_year'), ('shared_rules', 'contract_id'))) <> 3 then
    raise exception 'shared cost columns missing after the upgrade';
  end if;
  if (select count(*) from pg_policies where tablename in ('shared_rules', 'shared_entries') and policyname in ('member_read', 'member_insert', 'member_update', 'member_delete')) <> 8
     or exists (select 1 from pg_policies where tablename in ('shared_rules', 'shared_entries') and policyname = 'member_all') then
    raise exception 'shared account tables missing after the upgrade';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'chores' and policyname = 'member_all') then
    raise exception 'chores has no access policy';
  end if;
end $$;
select 'v3 upgrade tests passed' as result;
