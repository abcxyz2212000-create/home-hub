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
  if not exists (select 1 from pg_policies where tablename = 'chores' and policyname = 'member_all') then
    raise exception 'chores has no access policy';
  end if;
end $$;
select 'v3 upgrade tests passed' as result;
