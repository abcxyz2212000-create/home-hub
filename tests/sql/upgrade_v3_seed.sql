-- Data as it exists in production before the chores release (user master without nicknames).
insert into public.members (name, email, role) values ('共通（管理者）', 'owner@example.com', 'admin'), ('佐藤 春子', null, 'member');
insert into public.accounts (name, account_no, last4, holder_id)
  select '楽天銀行', '1234567', '4567', id from public.members where name = '佐藤 春子';
