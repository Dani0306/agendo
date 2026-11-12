-- T15: calls the send-reminders Edge Function every 10 minutes (prompt 003).
-- This is the only Agendo migration that touches objects outside schema `agendo`:
-- the pg_cron and pg_net extensions and one cron job, all named for Agendo.
--
-- Two Vault secrets must exist first. They are created by hand, not here, so no value
-- is committed:
--   agendo_project_url     https://<project-ref>.supabase.co
--   agendo_reminder_token  a random token, also set as the function's REMINDER_CRON_TOKEN
--
-- The header carries that narrow token, not the project's secret key: pg_net keeps
-- request headers readable in net.http_request_queue until it sends them.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'agendo-send-reminders',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'agendo_project_url') || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-agendo-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'agendo_reminder_token')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
