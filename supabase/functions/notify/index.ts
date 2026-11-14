// Supabase Edge Function "notify" (2026-11-07): the notifications that GitHub Actions used to send.
// Called by pg_cron every 10 minutes ({}) and on 1 December ({"mode": "wage"}) with the header
// x-notify-token, which the database checks (public.notify_token_ok: the token is kept in Vault).
// The code is scripts/notify.mjs and scripts/wage.mjs with the app's modules (web/js), deployed together.
// Function secrets: VAPID_PRIVATE_KEY; SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { runNotify } from './scripts/notify.mjs';
import { runWage } from './scripts/wage.mjs';

const SITE = 'https://househub-70o.pages.dev/';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const token = req.headers.get('x-notify-token') ?? '';
  const check = await fetch(`${url}/rest/v1/rpc/notify_token_ok`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
  });
  if (!check.ok || (await check.json()) !== true) return new Response('forbidden', { status: 403 });
  const body = await req.json().catch(() => ({}));
  const env = {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: key,
    VAPID_PRIVATE_KEY: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
    VAPID_SUBJECT: SITE,
    NOTIFY_TEST: body && body.test ? '1' : '',
  };
  const code = body && body.mode === 'wage' ? await runWage(env) : await runNotify(env);
  return new Response(JSON.stringify({ ok: code === 0 }), { headers: { 'Content-Type': 'application/json' }, status: code === 0 ? 200 : 500 });
});
