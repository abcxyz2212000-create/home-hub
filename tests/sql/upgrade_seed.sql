-- Data as it exists in a project created with the previous version (single owner, free-text holder).
insert into auth.users values ('11111111-1111-1111-1111-111111111111', 'Owner@Example.com');
insert into public.app_owner (user_id) values ('11111111-1111-1111-1111-111111111111');
insert into public.settings (key, value) values ('members', '["筒井 春香", "山田 花子"]');
insert into public.accounts (name, account_no, last4, holder, bank_code) values ('upgrade-survivor', '0001234', '1234', '筒井 春香', '0036');
insert into public.cards (name, holder) values ('カード', '別名 太郎');
