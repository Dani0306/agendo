# 003 — Phase 3: Cost control and reminders (T15–T18)

**Status:** approved
**Branches:** `feat/t15-reminders` → `feat/t16-t17-guards` → `feat/t18-caching`, stacked on `main`
**Phase:** 3 (see `CLAUDE.md` → Workflow)

## Goal

Reminders go out on schedule without ever sending twice. A customer who writes too fast and a tenant who has spent its budget both get a static reply with no model call. The saving from prompt caching is a measured number in a run file.

**Exit check (from `CLAUDE.md`):** reminders send on schedule, an over-budget tenant is blocked, and the cache saving is a recorded number.

## Session sizing

This doesn't fit one short session. It splits at three stopping points, each leaving the repo green:
1. T15 reminders. It needs you to enter six secrets in the Supabase dashboard.
2. T16 and T17, rate limits and budgets. They need an Upstash database from you.
3. T18 caching and its measurement.

Assumption: built in that order, one branch each.

## Docs read (10 Nov 2026)

- **Supabase "Scheduling Edge Functions":** `pg_cron` plus `pg_net`, with values kept in Vault. The page warns that "any role that can log in to your database can read the secret key while the request waits" in `net.http_request_queue`.
- **Supabase Edge Function secrets:** `SUPABASE_URL` and `SUPABASE_SECRET_KEYS` (a JSON object, key `default`) are set by default.
- **Supabase MCP:** `create_edge_function_secret` has the owner type the value in the dashboard, so secret values never pass through the agent.
- **Twilio "WhatsApp notifications with templates":** `ContentSid` plus `ContentVariables` as a JSON string keyed `"1"`, `"2"`.
- **Twilio trial page:** "Custom message bodies … and WhatsApp templates aren't available during trial."
- **Twilio Content API on this account:** returns `20003` (trial). So the built-in Appointment Reminders template's variables can't be read. They're **VERIFY**, settled by one test send.
- **Upstash Ratelimit "Getting started":** `@upstash/ratelimit` with `Redis.fromEnv()` reads `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; `limit()` returns `success`. The overview says a timed-out Redis call allows the request by default.
- **OpenAI prompt-caching guide:**
  - Implicit caching is the default for GPT-5.6 and later, with a minimum of 1,024 tokens.
  - Writes cost 1.25× input for 30 minutes, reads 0.1×.
  - `cached_tokens` excludes write tokens.
  - Explicit mode with no breakpoints caches nothing, which gives a clean "off" arm for the A/B.
- **Lab project extensions:** `pg_cron` and `pg_net` are available and not installed.

## Code inspected

- `supabase/migrations/20261108120000_foundation.sql`: `reminders` has `unique (booking_id, send_at)`; `tenant_usage` has reserved, settled and refunded columns.
- `src/lib/agent/loop.ts`: one `recordCall` per model call, so the budget can wrap each call.
- `src/lib/agent/handle-inbound.ts`: `agentReply` is the gate before any model call.
- `src/lib/pii/phone.ts`: the phone format is `v1:iv:tag:ciphertext`, AES-256-GCM.
- The earlier smoke run: 13,883 cached input tokens over 7 calls, so implicit caching already works.

## Decisions and assumptions

### T15 reminders

- **Who creates reminder rows.** A SQL function, `agendo.claim_due_reminders(lead, limit)`, creates them as it claims them. It finds confirmed WhatsApp bookings that are inside the 24-hour lead, whose customer gave consent and has a phone, and that have no reminder yet. It inserts the reminder rows with `on conflict (booking_id, send_at) do nothing returning`, so of two overlapping runs only one gets each row.
- **Rescheduling and cancelling.** A rescheduled booking gets a new `send_at` and therefore a new reminder. A cancelled one is never selected. Booking code doesn't need to know reminders exist.
- **Send at most once.** A claimed row is never claimed again. A crash between claim and send leaves it `pending` with no provider id: a missed reminder, never a repeat.
- **Bookings made inside the window** still get a reminder. It's redundant, but it lets you test without waiting a day.
- **Always the template.** The sandbox only offers built-in templates, and the trial can't send anything else. Outside the 24-hour window only a template is allowed anyway. The template says "Appt", never the treatment.
- **Template variables (VERIFY).** I'll send `{"1": "<day and date>", "2": "<time>"}`. If Twilio rejects that, the row is marked `failed` with the error code. It never falls back to sending the template unfilled, because its default text gives a wrong date ("Tue Oct 29").
- **The Edge Function** (`send-reminders`, Deno) is self-contained: plain `fetch` to PostgREST and Twilio, and WebCrypto to decrypt the phone. Its pure helpers are also tested from Vitest. That includes decrypting a phone encrypted by the Node code, which proves both runtimes agree.
- **How cron calls it.** pg_cron calls it every 10 minutes with a dedicated random token in a header, not the project's secret key. The queue warning above would otherwise expose a key that bypasses RLS, in a project PaperTrail shares. The function checks the token with a timing-safe comparison, and runs with `verify_jwt` off because of that check.
- **Sandbox limit.** The function sends at most 10 per run, 3 seconds apart, within the sandbox's one message every 3 seconds and the 150-second wall clock.
- **Outside `agendo`, needing your OK:**
  - install `pg_cron` and `pg_net`;
  - two Vault secrets (`agendo_project_url` and `agendo_reminder_token`);
  - one cron job, `agendo-send-reminders`;
  - one Edge Function, `send-reminders`.

  None of these touch PaperTrail's objects.

### T16 rate limits

- **Library:** `@upstash/ratelimit` and `@upstash/redis`, exact-pinned. Both are in the stack in `AGENTS.md`.
- **Starting limits (open decision 4):**
  - per customer: 10 per minute and 100 per day;
  - per web IP: 20 per minute and 200 per day.
- **Where it runs.** The customer limit runs in `agentReply` after the emergency check and before the cache and the agent, so an emergency is never rate-limited. It's keyed by customer id, which maps one-to-one to the keyed phone hash within a tenant. The IP limit runs in `/api/chat` before anything else.
- **Over the limit:** a static reply with `degraded: "rate_limited"` and no model call.
- **Fail-open on a Redis timeout.** The budget still caps spend, and a Redis blip shouldn't silence a clinic. Without Upstash env values, `next dev` runs with the limiter off and logs that once; `next start` refuses to start the web demo.

### T17 budgets

- **Three SQL functions:** `reserve_budget`, `settle_budget` and `refund_budget`. Each is one atomic statement on `tenant_usage`, and the reserve checks the limit inside its `UPDATE`, so two concurrent calls can't both pass the last dollar.
- **Who can call them:** `security invoker`, `search_path = ''`, executable by `service_role` only. Execute is revoked from `public`, `anon` and `authenticated`, because `agendo` is exposed through the API.
- **The month** is the tenant's local month.
- **The limit** is `monthly_budget_usd`. If it's null, the default is $5 (open decision 4).
- **The reservation** is the worst case for one call: estimated input tokens (characters ÷ 3) at the uncached rate, plus `maxOutputTokens: 600` at the output rate. Settled with the real cost from usage, and refunded when the call fails.
- **Over budget:** a static reply with `degraded: "over_budget"` and no model call. T20 turns it into the button menu.
- **Demo daily cap:** $0.50 a day across the demo tenant, summed from today's `model_calls` before each web turn. At the measured $0.0007 per conversation that's several hundred conversations.
- **Known gap:** a crash between reserve and settle leaves money reserved until the month ends. It's logged; a reconciliation job would be stretch.

### T18 caching

- **Prompt caching stays implicit.** The work here is measuring it. `scripts/cache-ab.ts` runs the smoke conversation twice, once with caching off (explicit mode, no breakpoints) and once on. It reads both arms' `model_calls` rows and writes `evals/runs/<date>-cache-ab.json` with prices, the date they were read, tokens, cost and the saving.
- **Exact-match FAQ cache in Redis.** Used only when:
  1. the customer has said nothing yet besides ACEPTO or NO, so the answer can't depend on earlier turns;
  2. the text has at least three words;
  3. on writing, the agent ran no tool, which keeps booking intents out by construction.
- **Cache key:** tenant, a hash of the tenant's FAQ, services and hours (so editing any of them invalidates it), the tenant's local date (so "¿atienden hoy?" can't go stale), and a SHA-256 of the normalized text. Health details a patient types never become a readable Redis key.
- **Expiry:** one day.
- **A hit** has no model call and shows `faq_cache → hit` in the trace.

### Not built here

The fallback model and the menu (T20), retries (T19), output rules (T23) and a dashboard view of the numbers (T26).

## What this teaches

- **24-hour window and templates (T15).** Outside 24 hours since the customer last wrote, only an approved template can be sent, and buttons need one even inside. So the reminder is always a template, named in the row. Rejected: free text when the window happens to be open. It saves nothing here and splits the code into two paths.
- **Rate limiting (T16).** The counters live in Redis, because each serverless instance has its own memory and resets on a cold start. Rejected: an in-process limiter, which lets a burst through as soon as two instances run.
- **Per-tenant budgets (T17).** Reserve the worst case before the call, then settle with the real tokens or refund on failure, in one atomic statement each (Classly's pattern). Rejected: checking spend after the call, which lets concurrent calls all pass the last dollar.
- **Prompt caching (T18).** Keep the stable part first and measure with an A/B on identical conversations. Rejected: claiming the saving from one run's cached-token count, because that ignores the write premium.

## Files to touch

- `supabase/migrations/20261110120000_reminders_and_budget.sql` — create — the claim function, the three budget functions and their grants.
- `supabase/migrations/20261110120100_reminder_schedule.sql` — create — extensions and the cron job (reads values from Vault; no values in the file).
- `supabase/tests/budget.sql` — create — rolled-back test: limit honoured, settle and refund arithmetic, grants.
- `supabase/functions/send-reminders/{index.ts,reminder.ts,reminder.test.ts,deno.json}` — create.
- `src/lib/guard/{rate-limit,budget,response-cache,redis}.ts` + tests — create.
- `src/lib/agent/{loop,handle-inbound,reply,runtime}.ts`, `src/app/api/chat/route.ts`, `src/app/chat-demo.tsx` — edit.
- `scripts/cache-ab.ts`, `scripts/lib/scripted-conversation.ts`, `scripts/agent-smoke.ts` — create and edit.
- `tsconfig.json`, `vitest.config.mts`, `package.json`, `.env.example`, `CLAUDE.md`, `AGENTS.md` — edit.

## Requirements

1. A cron run sends each due reminder once. Two runs at the same time claim disjoint rows. Cancelled bookings, web customers and customers without consent are never selected.
2. A reminder never names the service. The row records the template, status and provider id, and a failure records the error code with no phone in it.
3. The Edge Function refuses a request without the right token (401) and never logs a phone.
4. Rate limit and budget run before every model call. When either refuses, no model call happens and the customer gets a static reply.
5. Each model call has one reservation, settled with the cost `recordCall` computed, or refunded on failure.
6. A concurrent test shows the last dollar can't be spent twice.
7. A cache hit makes no model call. A booking message is never stored in the cache.
8. The A/B run file holds both arms' per-call tokens and costs, and the saving computed from them.

## Security, PII and data safety

- **Keys stay server-side:**
  - Twilio, encryption and cron-token secrets reach the Edge Function only through dashboard-entered secrets.
  - Upstash values live in `.env.local`.
  - The cron header carries a narrow token, not the RLS-bypassing key.
- **Synthetic data:** the A/B and SQL tests use synthetic visitors and roll back or clean up after themselves.
- **Phones and health data:** the function decrypts a phone only to send and never logs it. The response cache keys on a hash, and the reminder text holds no treatment.

## Cost impact

- **A/B run:** two smoke conversations, about $0.0015 from the measured $0.0007 each, with a $0.05 stop.
- **Twilio:** test reminders use the trial's free units, about 2 to 4 of the 98 left.
- **Upstash and Supabase:** free tier. At 10-minute cron intervals that's about 4,300 Edge Function calls a month.
- **Per turn:** two or three Redis commands per guarded turn.

## Acceptance criteria

- [ ] The rolled-back SQL tests pass on the lab project (claim exclusivity, selection rules, budget arithmetic, grants).
- [ ] A reminder arrives on your phone for a booking made through WhatsApp, and the row shows `sent` with a provider id.
- [ ] A second function run sends nothing for it.
- [ ] Over budget: a tenant with its limit set to $0 gets the static reply and no `model_calls` row.
- [ ] Rate limit: the 11th message in a minute gets the static reply.
- [ ] The cache A/B run file exists, and its saving is recorded in `CLAUDE.md` → Cost model.
- [ ] typecheck, lint, unit tests, Playwright, build and `deno check` pass. The security advisor reports nothing new.

## Checks

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`
- `deno check supabase/functions/send-reminders/index.ts`
- `npm run cache:ab` (once)

## Manual test steps

Filled in with exact steps when the work is done. Your hand steps:
1. Create a free Upstash Redis database and paste its two values into `.env.local`.
2. Enter six Edge Function secrets in the dashboard when prompted.
3. On WhatsApp, send `ACEPTO` and a booking request for tomorrow. Replies won't arrive on the trial, but the booking is still stored.
4. Watch for the reminder.

## Results

Filled in after the work.
