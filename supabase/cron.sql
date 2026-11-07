-- Notifications on Supabase (2026-11-07): pg_cron calls the Edge Function "notify" every 10 minutes, and
-- on 1 December for the reminder of next year's ratio. Replaces the GitHub Actions workflows notify.yml
-- and wage.yml. Run once on the project (not part of schema.sql: the test database has no pg_cron).
-- The token that the function checks is kept in Vault; nothing secret is written here.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- a random token, made once
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'notify_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'notify_token', 'checked by the Edge Function notify');
  end if;
end;
$$;

-- the Edge Function asks whether a request came from pg_cron (service_role only)
create or replace function public.notify_token_ok(p_token text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_token <> '' and p_token = (select decrypted_secret from vault.decrypted_secrets where name = 'notify_token'), false);
$$;
revoke all on function public.notify_token_ok(text) from public, anon, authenticated;
grant execute on function public.notify_token_ok(text) to service_role;

-- calls the function with the token (body: {} = the regular run, {"mode":"wage"} = the yearly reminder)
create or replace function public.call_notify(p_body jsonb default '{}'::jsonb)
returns bigint language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://fhlskaiixzwfjuuoetuf.supabase.co/functions/v1/notify',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-notify-token', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_token')),
    body := p_body,
    timeout_milliseconds := 120000);
$$;
revoke all on function public.call_notify(jsonb) from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname in ('househub-notify', 'househub-wage');
select cron.schedule('househub-notify', '3-59/10 * * * *', $$select public.call_notify('{}'::jsonb)$$);
-- 1 December 9:23 Japan time = 0:23 UTC
select cron.schedule('househub-wage', '23 0 1 12 *', $$select public.call_notify('{"mode":"wage"}'::jsonb)$$);
