// Supabase connection settings. Fill in the two values from the Supabase dashboard
// (Project Settings -> API). Only the PUBLIC key goes here: it is meant to be public,
// and the data is protected by row level security. Never put the secret/service_role key here.
export const CONFIG = {
  // e.g. 'https://abcdefghijklmnop.supabase.co' (no trailing slash)
  supabaseUrl: '',
  // "Publishable key" (sb_publishable_...) or legacy "anon public" key (eyJ...)
  supabaseKey: '',
};
