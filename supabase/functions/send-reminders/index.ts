// Sends due appointment reminders. Called by pg_cron every 10 minutes (see
// supabase/migrations/20261112120100_reminder_schedule.sql). Each claimed reminder is
// sent once: claim_due_reminders never returns a row twice.
import { decryptPhone, providerErrorCode, reminderVariables, safeEqual, templateForm } from "./reminder.ts";

const LEAD = "24 hours";
const BATCH = 10;
/** The Twilio Sandbox sends one message every 3 seconds. */
const SPACING_MS = 3_000;

type Env = {
  supabaseUrl: string;
  secretKey: string;
  twilioSid: string;
  twilioToken: string;
  twilioFrom: string;
  contentSid: string;
  phoneKey: string;
};

type DueReminder = { reminder_id: string; starts_at: string; timezone: string; phone_encrypted: string };

function readEnv(): Env | null {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  const values = {
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    secretKey: keys ? (JSON.parse(keys) as Record<string, string>)["default"] : undefined,
    twilioSid: Deno.env.get("TWILIO_ACCOUNT_SID"),
    twilioToken: Deno.env.get("TWILIO_AUTH_TOKEN"),
    twilioFrom: Deno.env.get("TWILIO_WHATSAPP_FROM"),
    contentSid: Deno.env.get("REMINDER_CONTENT_SID"),
    phoneKey: Deno.env.get("PHONE_ENCRYPTION_KEY"),
  };
  return Object.values(values).every((value) => typeof value === "string" && value.length > 0) ? (values as Env) : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function rest(env: Env, path: string, init: { method: string; body: unknown; prefer?: string }): Promise<Response> {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    method: init.method,
    headers: {
      apikey: env.secretKey,
      "Content-Type": "application/json",
      "Content-Profile": "agendo",
      "Accept-Profile": "agendo",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: JSON.stringify(init.body),
  });
  if (!response.ok) throw new Error(`PostgREST ${path}: HTTP ${response.status}`);
  return response;
}

async function markReminder(env: Env, id: string, fields: Record<string, string | null>): Promise<void> {
  await rest(env, `reminders?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: fields, prefer: "return=minimal" });
}

async function sendTemplate(env: Env, phone: string, startsAt: Date, timezone: string): Promise<string> {
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.twilioSid}:${env.twilioToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: templateForm({ to: phone, from: env.twilioFrom, contentSid: env.contentSid, variables: reminderVariables(startsAt, timezone) }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(providerErrorCode(response.status, body));
  return (body as { sid: string }).sid;
}

Deno.serve(async (request) => {
  const token = Deno.env.get("REMINDER_CRON_TOKEN");
  if (!token || !safeEqual(request.headers.get("x-agendo-cron") ?? "", token)) return json({ error: "unauthorized" }, 401);

  const env = readEnv();
  if (!env) return json({ error: "not_configured" }, 500);

  const claim = await rest(env, "rpc/claim_due_reminders", { method: "POST", body: { p_lead: LEAD, p_limit: BATCH } });
  const due = (await claim.json()) as DueReminder[];

  let sent = 0;
  let failed = 0;
  for (const [index, reminder] of due.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
    try {
      const phone = await decryptPhone(reminder.phone_encrypted, env.phoneKey);
      const sid = await sendTemplate(env, phone, new Date(reminder.starts_at), reminder.timezone);
      await markReminder(env, reminder.reminder_id, { status: "sent", provider_message_id: sid, error: null });
      sent += 1;
    } catch (error) {
      const code = error instanceof Error && /^(twilio|http)_\d+$/.test(error.message) ? error.message : "send_error";
      await markReminder(env, reminder.reminder_id, { status: "failed", error: code }).catch(() => undefined);
      failed += 1;
    }
  }

  // Counts only: never a phone, a name or a time.
  console.log(JSON.stringify({ event: "reminders.run", claimed: due.length, sent, failed }));
  return json({ claimed: due.length, sent, failed });
});
