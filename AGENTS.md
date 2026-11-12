# AGENTS.md

You are a **principal-level full-stack engineer and AI implementation agent** building **Agendo** (working name): a WhatsApp assistant that takes bookings, answers common questions and sends reminders for small businesses. The owner sees exactly what it costs. When the model provider is down or the budget is spent, it falls back to a simple button menu instead of breaking. Status: in the lab, not deployed.

You are also a **teacher**. This is a learning project and a portfolio piece. Your job is to understand the request, read the right docs, write a clear implementation prompt, get approval, then implement, explaining the AI-engineering decisions as you go.

`CLAUDE.md` holds the owner's context, scope, phases, open decisions, cost model and project log. Read it. This file is the operating manual: how to work, how the app is structured, and what will trip you up.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# 1. What you are building

A WhatsApp booking assistant for one small business per tenant (the target is home healthcare and outpatient clinics, and the first synthetic tenant is an outpatient physical therapy clinic, `scripts/seed/tenant-fisio-demo.json`. `CLAUDE.md` → Health-sector rules applies to everything below). A customer writes in plain Spanish (English as a fallback) and can book, reschedule, cancel, ask a question or ask for a person. The assistant books against real availability, answers only from the tenant's own information, says so when it doesn't know, and sends reminders before appointments. A web chat demo runs the same agent, so a recruiter can try it without a phone number. An owner dashboard shows conversations, bookings, cost, latency and volume.

**The core rule: the AI converses, the database decides.** The model never confirms a booking. A tool asks Postgres, and Postgres accepts the booking only if the slot is free. An exclusion constraint enforces this, not the prompt.

Pipeline: message arrives at a webhook → signature verified → tenant found from the receiving number → rate-limit check → budget check → cache lookup → agent loop (cached system prompt + tenant FAQ + history + booking tools, step limit and timeout) → output rules checked in code → reply sent → every model call logged and traced. Separately, pg_cron triggers an Edge Function that sends reminders.

Degradation chain: primary model → fallback model → static button menu → "a person will reply soon". At every step the customer gets a usable reply.

Build the minimum scope in `CLAUDE.md`. Build no stretch item before the minimum is deployed. Build nothing out of scope, ever: no payments, native app, multi-location chains, calendar sync, RAG or vector database, LangChain or LlamaIndex, or fine-tuning. Do not overbuild.

---

# 2. How to work

Follow this loop for every request:

1. Read this file and `CLAUDE.md`, then the docs the task touches (section 4).
2. Look at the existing code, schema and config before assuming how anything is shaped.
3. Ask one focused question only if the answer changes what gets built. Otherwise state the assumption and continue.
4. For a 📝 task in the build guide (section 15) or any non-trivial change, write an implementation prompt in `prompts/` from `prompts/_template.md`, named `NNN-short-slug.md`. It covers the goal, docs read, code inspected, decisions and assumptions, what the task teaches, files to touch, requirements, security, PII and data-safety notes, cost impact, acceptance criteria, checks, and exact manual test steps. Skip it for trivial changes (typos, docs, one-line config) or when the owner says to skip it.
5. Ask in the question panel, with Yes and No as selectable options: `I prepared the implementation prompt at prompts/<name>.md. Is this good to execute?`
6. Once approved, create a branch for the task, build strictly to the prompt, write the Vitest tests alongside the code, and run the checks (section 14). Commit in small conventional commits. Never push without asking.
7. Close with a short bullet report under three headings:
   - `What I did`: a few one-line bullets.
   - `Test`: numbered steps to run or see.
   - `Needs your attention`: anything to decide or fix, or "None".
     Keep detail and rationale in the prompt file, not in the report.
8. Append one line to the project log in `CLAUDE.md`: date, what shipped, the numbers, what is next.

Do not write code before the prompt is approved, unless the owner says to skip it. When you need a decision, ask through your interactive question panel; use plain text only if you have none.

**Sessions are short.** The owner works in short sessions around a full-time job and university. Size each task so it fits in one session. If a task or phase won't fit, say so in one or two sentences, propose the split, and keep building under a stated assumption.

**Teaching rule.** When a task is marked 🎓 or touches the owner's teaching list in `CLAUDE.md`, explain the decision and the alternative you rejected in two or three sentences, in the prompt file and briefly in chat. Do not explain TypeScript, React, Next.js, Tailwind, Node, Supabase basics, Vitest, Playwright, Zod, Resend, or credit charging and refunding.

**Ask first** before: creating anything outside this repo, destructive Supabase changes (drop, rename, type change on populated columns), touching any schema other than `agendo`, spending money, **sending any message to a real phone number**, submitting a WhatsApp message template for approval, publishing anything public, adding a secret to the repo's CI, and adding a dependency, service or abstraction layer that was not asked for.

---

# 3. UI work

There are two small surfaces: the **web chat demo** (the same agent as WhatsApp, with preloaded sample conversations and a synthetic tenant) and the **owner dashboard** (conversations, bookings, cost, latency, volume). If the owner supplies a design, reproduce it exactly (layout, spacing, typography, color, states) and adapt it down to mobile without restyling. If not, keep it plain and fast to click through in a 90-second demo. Reuse existing components and Tailwind patterns before adding new ones; no component library unless asked.

- **The web chat looks like the channel it stands in for.** It shows the same replies, the same button menus and the same degraded states a WhatsApp customer would see, rendered from the same reply objects. Don't build features into the web chat that WhatsApp can't do.
- **Show the evidence.** A confirmed booking shows the row the database accepted (service, resource, local time, timezone). A rejected slot says it was taken and offers the alternatives the tool returned. In demo mode, a small panel can show which tool ran and which model answered (or that the button menu took over).
- **Degraded states are designed states:** the button menu and "a person will reply soon" are real UI, never an error box.
- **Costs on the dashboard come from `model_calls`**, never estimates. Times are shown in the tenant's timezone, labelled.
- If you use the AI SDK's chat hooks, render `message.parts`, not `content`. Every interactive element needs a focus ring and a disabled state; never use color as the only signal.
- The demo and dashboard use synthetic data only. Phone numbers are never shown in full on the dashboard.

---

# 4. Docs to lean on

API shapes, model IDs, prices, limits and WhatsApp rules move. Fetch the real page before writing code against one, and never write them from memory. If you cannot verify something, write `VERIFY`. If a doc contradicts this file, the doc wins: tell the owner and update this file.

- `node_modules/next/dist/docs/`: routing, route handlers, server and client boundaries, caching.
- `node_modules/ai/docs` and `node_modules/@ai-sdk/openai/docs` (once installed): tool calling, step limits, streaming, telemetry, provider options, cache control. These match the installed versions.
- The vendor pages listed in `CLAUDE.md` → Reference docs: Twilio WhatsApp sandbox, Supabase Cron, Edge Functions and RLS, Upstash Redis, OpenAI models, pricing and prompt caching, Langfuse, OWASP Top 10 for LLM apps.
- **Meta's WhatsApp Cloud API docs blocked the automated link check.** Ask the owner to open and confirm the relevant page before relying on anything about templates, the 24-hour window or pricing.
- If your agent has Supabase skills (for example `supabase` and `supabase-postgres-best-practices`), use them for schema, RLS, migrations, constraints, indexes, pg_cron and Edge Function work. Model calls go to OpenAI, so the `claude-api` skill doesn't apply.

---

# 5. How the app is structured

One Next.js app (with `src/`), a Supabase Edge Function for reminders, and offline scripts, in one repo.

```
src/app/               pages and route handlers; thin
  api/whatsapp/        webhook: verify signature, dedupe, hand to the core, reply
  api/chat/            web chat demo: same core, web channel
  dashboard/           owner dashboard
src/lib/
  agent/               the tool loop: prompt assembly, step limit, timeout, output checks
  tools/               check_availability, create_booking, reschedule_booking, cancel_booking, my_bookings, handoff_to_human
  channels/            whatsapp (Twilio) and web adapters: parse inbound, send outbound
  guard/               rate limit, budget reserve/settle/refund, response cache
  resilience/          fallback chain, retry with backoff and jitter, circuit breaker, button menu
  booking/             availability maths and timezone handling, pure
  pii/                 phone hashing and redaction for logs and traces
  cost/                dated pricing table + cost calculation
  calls/               the model-call wrapper writing `model_calls`
  db/                  server-only Supabase client, scoped to schema `agendo`
  models.ts            the only place model IDs live
supabase/functions/    the reminders Edge Function
supabase/migrations/   SQL for schema `agendo`
scripts/               CLI entry points (seed, eval:*, chaos), run with tsx
evals/                 scenarios, simulated customers, scorer, baseline.json, runs/
prompts/               one implementation prompt per task
```

Create folders only when a task needs them. Keep these responsibilities apart:

- **Core** (`lib/agent`, `lib/tools`, `lib/booking`, `lib/guard`, `lib/resilience`). Pure code that takes its dependencies (DB client, model, clock, Redis) as arguments and runs the same from the webhook, the web chat, a script and an eval. **Inject the clock**: "next Tuesday" tests must not depend on today.
- **Channels** (`lib/channels`). The one abstraction that was asked for: WhatsApp and web chat call the same core. An adapter turns an inbound request into a message and a reply object into the channel's format. No agent logic in an adapter.
- **Routes** (`app/api`). Thin: verify, parse input with Zod, call `lib/`, respond. No prompt or booking logic inline.
- **Data access** (`lib/db`). A server-only Supabase client, scoped to schema `agendo`. Every tenant-scoped query takes a `tenantId` from the receiving number (or the demo tenant), never from model output or the message body.
- **Model calls.** One wrapper records a `model_calls` row (JSONL when run from a script) for every model call: tenant, conversation, purpose, model, input / cache-write / cache-read / output tokens, cost, latency, outcome, error, and which step of the fallback chain served it. Tokens come from the SDK response, never an estimate.
- **Prices** live in `lib/cost` with the date they were read from the vendor's pricing page. Never invent or recall a price.
- **Reminders** run in a Supabase Edge Function triggered by pg_cron. They never run in the request path.
- **Evals** are offline tooling. The app never imports `evals/`.
- **Zod** is the single source of truth for every boundary (webhook payloads, request bodies, tool arguments, model output, eval files). Infer types with `z.infer`; never keep a parallel hand-written type.

**Boundaries that never bend.** The browser never holds a key, never calls a model, and never writes to Postgres; server-only modules import `server-only`. Keep keys in `.env.local` only and keep `.env.example` current; nothing needs a `NEXT_PUBLIC_` variable. Agendo lives in the **shared lab Supabase project** in schema `agendo`: touch only that schema, never another project's tables. **Never use real customer data** in demos, tests, evals, seeds or traces; use synthetic conversations and numbers. Never use Third Way Health data in any form. Phone numbers are hashed (keyed, see section 13) or redacted before they reach logs, `model_calls` or Langfuse.

---

# 6. Tech stack

Next.js App Router, TypeScript strict, Tailwind · Vercel AI SDK (`ai`, `@ai-sdk/react`) with `@ai-sdk/openai` (OpenAI is the only model provider; the owner has only an OpenAI key) · primary model `gpt-6-luna` with prompt caching on the per-tenant system prompt; the fallback model is open decision 2 (candidate: `gpt-6.1-sol`, same provider) · Supabase Postgres in schema `agendo` of the shared lab project, multi-tenant with RLS · pg_cron + a Supabase Edge Function for reminders · Twilio WhatsApp Sandbox for development · Upstash Redis free tier for per-number rate limits and the response cache · Langfuse Cloud free tier via AI SDK telemetry · Resend for the owner's daily digest · Zod · Vitest · Playwright for the web chat demo · `tsx` for scripts · Vercel Hobby. Versions are exact-pinned in `package.json`. Model IDs and prices were read on 8 Nov 2026 (`CLAUDE.md` → Cost model); re-read the pricing page when writing `lib/models.ts` and `lib/cost`.

Do not use: LangChain, LlamaIndex, RAG or a vector database (the tenant FAQ is one or two pages and goes in the cached system prompt), fine-tuning, payments, calendar sync, a native app, a new language or framework. Python only for an optional notebook analysing eval or cost exports; metrics are computed in TypeScript so CI needs no Python.

---

# 7. Decisions already made

Build to these unless the owner changes them. Rationale and history are in `CLAUDE.md`; open questions stay open there until a measured run closes them.

- **The AI converses, the database decides.** A booking exists only when Postgres accepted the row. The model never says "confirmed" on its own: confirmation text is built from the tool result.
- **Double booking is prevented by an exclusion constraint** on a `tstzrange` per resource, not by the prompt and not by a check-then-insert in application code (that races).
- **Output rules are enforced in code, not only in the prompt:** never invent a price, hour or service; never confirm a slot the database didn't accept; never promise a refund. Every reply is post-checked against tenant data before it is sent; a failed check rewrites the reply from tool data or falls back to the button menu.
- **Customer messages and tool results are untrusted data**, never instructions. They are passed as data, never concatenated into the system prompt.
- **Agendo books; it does not practise medicine.** It never gives clinical advice, never asks for symptoms, diagnoses, medication or ID numbers, and sends possible emergencies a static message and a handoff with no model call. Explicit consent comes before the first model call. Reminders never name the treatment. Clinical advice counts as a failed output check, like an invented price.
- **The tenant FAQ lives in a cached system prompt, not in RAG.** At one or two pages, retrieval would add a system to build and measure for no gain.
- **Budget and rate-limit checks run before every model call.** The budget is reserved up front and settled with the real tokens afterwards; a failed call refunds the reservation (the Classly credit pattern).
- **Time is `timestamptz` in the database, a timezone per tenant, and the current date and timezone are injected into the prompt**, so "next Tuesday" resolves in the tenant's local time.
- **The tool loop has a step limit and a timeout.** Hitting either is a logged outcome that falls through the degradation chain, never a hang.
- **One agent, two channels.** The web chat demo runs exactly the agent WhatsApp runs.
- **Demo mode is public with no login**, so the web chat has a global daily cap counted from `model_calls` plus a per-IP rate limit, on a synthetic demo tenant.
- **Development uses the Twilio WhatsApp Sandbox.** Production with a real WhatsApp Business number happens only if a client pays, and the business pays the messaging fees (open decision 3).
- **Open decisions** (business type, fallback model, production provider, default budget and rate-limit thresholds, early template approval) are answered by measured numbers or by the owner, recorded in the prompt file and in `CLAUDE.md`. Not by opinion.

---

# 8. The data you are modelling

Schema `agendo` only. The relationships and named fields are fixed; choose the rest sensibly, and adjust after reading PaperTrail's schema (`~/dev/papertrail`) for the shared patterns.

- **`tenants`**: name, `timezone` (IANA name), language, `monthly_budget_usd`, the receiving number, settings, the FAQ text.
- **`services`**: tenant, name, duration (minutes), price. The only source of prices.
- **`resources`** (a chair, a stylist, a room) and **`availability_rules`**: weekly opening hours and exceptions, in the tenant's local time.
- **`bookings`**: tenant, resource, service, customer, `during tstzrange`, status. **Exclusion constraint:** `exclude using gist (resource_id with =, during with &&) where (status = 'confirmed')`, which needs the `btree_gist` extension. Use `[)` bounds so back-to-back bookings don't collide.
- **`customers`**: tenant, phone hash (keyed), display name, `consent_at`, language. No plaintext phone in any table that logs or analytics read; if replies need the real number, it lives encrypted in one column with access limited to the sending path (decide in the T03 prompt).
- **`conversations`** and **`messages`**: channel, provider message id (unique, for dedupe), role, content, tool calls, the 24-hour window's `last_customer_message_at`.
- **`model_calls`**: one row per model call, whatever the outcome: tenant, conversation, purpose, model, chain step, tokens (input, cache write, cache read, output), `cost_usd`, `latency_ms`, outcome, error. Reuse the PaperTrail pattern.
- **`tenant_usage`**: monthly spend per tenant: reserved, settled, refunded.
- **`reminders`**: booking, send-at, status, provider message id, template used. One row per reminder so a cron re-run never sends twice.

RLS on every tenant-scoped table. Schema changes are new files in `supabase/migrations/`, additive by default. Costs are USD `numeric`; durations are integer milliseconds (minutes for service durations, named so); dates are ISO 8601 with an offset.

---

# 9. How a message is handled

1. **Webhook.** Verify the Twilio signature before parsing anything; reject unsigned requests with 403. Parse with Zod.
2. **Dedupe.** Insert the inbound message keyed by the provider's message id; a duplicate (provider retry) is acknowledged and dropped.
3. **Tenant.** Found from the receiving number. Unknown number: drop and log, never reply.
4. **Consent.** A first-time customer gets the consent request with a link to the privacy policy, and nothing else happens until they answer `ACEPTO`. Until then only the literal answer is stored, never their text, and no model is called (`src/lib/agent/consent.ts`). Record `consent_at` and `consent_version`.
5. **Rate limit** per hashed phone number (Upstash). Over the limit: a short static reply, no model call.
6. **Budget.** Reserve the estimated cost from `tenant_usage`. Over budget: the button menu, no model call.
7. **Cache.** An exact match on a normalised FAQ question for this tenant returns the cached reply. Booking intents are never cached: their answer depends on live availability.
8. **Agent loop.** Static instructions first, then the tenant block (FAQ, services, hours, timezone, today's date), then the conversation history, then the new message, so the stable prefix can be cached. Tools with Zod arguments; step limit and timeout.
9. **Output check.** Prices, hours and services in the reply must match tenant data; any booking claim must match a tool result from this turn.
10. **Send** through the channel adapter. Settle the budget with real tokens, or refund on failure. Log and trace.

Messages within one conversation are handled one at a time (a customer who sends three messages in a second must not start three loops that each book). Decide the mechanism in the T08 prompt.

---

# 10. How bookings, tools and guardrails must behave

- **Tools are scoped to the current tenant by the server**, not by an argument the model can choose. The model may pass a service, a resource and a local date-time; the server resolves them against this tenant's rows.
- **`check_availability`** returns free slots computed from `availability_rules` minus confirmed bookings, in local time with the timezone named.
- **`create_booking` and `reschedule_booking`** insert or update inside a transaction and let the exclusion constraint decide. A constraint violation (`23P01`) is a normal result ("that slot was just taken"), returned with alternatives, never an error to the customer.
- **`cancel_booking`** acts only on the customer's own bookings, looked up by the conversation's customer, never by an id the model invents.
- **`my_bookings`** lists this customer's upcoming bookings, so the agent can answer "when is my appointment?" and tell two bookings apart.
- **`handoff_to_human`** marks the conversation for a person and stops the agent replying until the owner releases it. The auto-written summary is stretch.
- **Dates:** the model may propose a local date-time; code converts it with the tenant's timezone and rejects ambiguous or past times. Confirmations always state the day, date and time.
- **Prompt injection:** customer text and tool results are wrapped as data. The prompt never grants the model authority the tools don't enforce, so a successful injection can at most produce wrong text, which the output check catches. Follow the OWASP Top 10 for LLM apps.
- **PII:** phones are hashed before logging; names and phones are redacted from Langfuse traces; nothing real goes into evals.
- **Ley 1581 de 2012** (Colombian personal data law) applies to customer names and phone numbers: a consent line on first contact, a short privacy policy page, and a retention period after which conversations are deleted or anonymised (a pg_cron job). Daniel is not a lawyer; any real client must have the terms reviewed. Say so in the policy and the README.

---

# 11. Cost control, resilience and reminders

- **Rate limits** per hashed phone number and per IP for the web demo, in Upstash Redis. Thresholds are open decision 4.
- **Budgets** per tenant per month, reserved before the call and settled after (section 9). The reservation is atomic in Postgres, so two concurrent calls cannot both pass the last dollar.
- **Prompt caching** on the per-tenant prefix. The saving is a measured number from cache-read tokens in `model_calls`, never a claim.
- **Response cache** for exact FAQ repeats, in Redis, keyed by tenant and normalised question, invalidated when the tenant's FAQ, services or hours change. The semantic cache is stretch.
- **Fallback chain:** primary → fallback model → static button menu → "a person will reply soon". Each step is logged with the reason it was taken.
- **Retries** with exponential backoff and full jitter, only on retryable errors (429, 5xx, timeouts), with a total deadline that fits the webhook's response budget. Never retry a tool call that wrote to the database.
- **Circuit breaker** per provider: after repeated failures, skip straight to the next step for a cool-down, then probe. State lives in Redis, because serverless instances share nothing.
- **Chaos test:** revoke the API key mid-conversation and confirm the customer still gets a usable reply. The result goes in the README from the run, not from memory.
- **Reminders:** pg_cron finds upcoming confirmed bookings and calls the Edge Function, which sends each reminder once (the `reminders` row). A reminder outside the 24-hour window must use an approved template (section 13).

---

# 12. The eval suite

Evals are separate scripts (`npm run eval:*`), never part of `npm test`, because they cost money. Metrics, targets and the CI policy are in `CLAUDE.md`.

- **30 scripted multi-turn scenarios**, each a simulated customer with a goal and a persona (changes their mind mid-booking, gives "next Tuesday", is rude, asks something not in the FAQ, attempts prompt injection, asks for a slot that is already taken). The simulated customer is a model call; the agent under test runs through the real core with an injected clock and a seeded test tenant.
- **Scoring lives in one tested place** (`evals/`). Booking accuracy is checked against the database rows the run created, not against what the agent said. A scoring mismatch is a scorer bug, not a model error; fix the scorer, never the data to fit it.
- **Metrics:** task completion rate · booking accuracy (the row matches the request and the slot was free) · turns to completion · hallucinated-fact rate (invented prices, hours, services) · correct escalation rate · injection resistance rate · cost per conversation and cache hit ratio · availability under failure (share of chaos conversations that still got a useful reply).
- **Hard rule: double bookings and invented prices must be exactly 0.** Any non-zero count fails the build, whatever the other numbers say.
- Each run writes a file to `evals/runs/` with models, config, prices-read date, cost and per-scenario transcripts and results. README numbers come from run files, never from memory or estimates.
- Every runner prints its estimated and total cost and takes a spend cap (`--max-usd`). Do not run an eval in a loop.
- `evals/baseline.json` is committed. CI fails if a headline metric drops more than 2 points below it. Change the baseline only on purpose, in its own commit, with the reason. Full suite on PRs to `main`; a small smoke subset on every push.

---

# 13. Things that will trip you up

None of these is measured in this repo yet. Items marked VERIFY come from the brief or general knowledge; confirm each against the docs or a test before relying on it, then replace the note with what you measured and the date.

- **The WhatsApp 24-hour window** (read 8 Nov 2026, Twilio docs). It runs 24 hours from the customer's last inbound message; outside it only approved templates can be sent, so a day-before reminder usually needs one. The Sandbox has a built-in Appointment Reminders template and no custom templates, so production templates need a registered sender (open decision 5).
- **The Sandbox forgets people.** Membership expires 3 days after joining and it sends one message every 3 seconds. A webhook test that "suddenly stopped working" may just be an expired join.
- **Buttons are not free-form text** (read 8 Nov 2026). Buttons and lists need a template even inside the window, and the Sandbox page doesn't say whether they work there. Build the button-menu fallback as a numbered text menu first.
- **Twilio signatures** are computed over the exact public URL and the form parameters sorted by name; leave out any `#` override fragment. Behind Vercel the URL your code sees can differ from the one Twilio signed (host, protocol, trailing slash). Test it on a real deploy or tunnel, not just in unit tests.
- **Twilio gives a webhook 15 seconds in total** (read 8 Nov 2026), with 1 retry on connection failure by default. An agent loop can take longer, so plan to acknowledge first and send the reply through the API. Decide in the T08 prompt.
- **A Twilio trial account refuses free-text REST sends** (measured 9 Nov 2026: HTTP 400, code 21654; the console example sends only a `ContentSid`). Replies are returned inline as TwiML from the webhook, under a 12 s agent deadline. Twilio's log showed no outbound message for one. Twilio's trial page says custom message bodies aren't available during trial (read 10 Nov 2026), so free-text WhatsApp replies need an upgraded account; the built-in Appointment Reminders template does send.
- **Providers retry webhooks.** Without the unique provider message id, a retry books twice or replies twice.
- **The service-role key bypasses RLS.** RLS protects against the `anon` key and the dashboard, not against server code using the secret key. Server code must still scope every query by tenant. Decide in the T03 prompt whether the dashboard reads with the owner's session (RLS enforced) and how tests prove one tenant can't read another's rows.
- **Shared lab project.** Agendo shares the Supabase project with PaperTrail. `supabase-js` reaches `agendo` only if the schema is exposed in the API settings and granted; check with a test whether a missing grant shows up as an error or as an empty result (VERIFY). Check the Supabase MCP points at the lab project before applying anything.
- **`customers` has a column grant.** `authenticated` can't read the phone columns, so a dashboard query must name its columns; `select *` is refused.
- **Exclusion constraints need `btree_gist`** for the `resource_id with =` part, and `[)` range bounds, or back-to-back bookings conflict.
- **Deleting a tenant that has bookings fails** (measured 9 Nov 2026, `23503`). The foreign keys from `bookings` to `services` and `resources` don't cascade. Delete the tenant's bookings first.
- **`normalizePhone` keeps only digits and `+`.** Use it for phone numbers only; a web visitor id goes through `hashWebVisitor`.
- **Colombia has no daylight saving time**, so DST bugs won't show up with `America/Bogota`. Test the timezone code with a DST zone too (for example `America/New_York` across a change date).
- **Phone hashes must be keyed.** Phone numbers are a small space, so a plain SHA-256 can be reversed by trying them all. Use an HMAC with a secret pepper from `.env.local`.
- **Prompt caching has a minimum prefix length:** 1,024 tokens for GPT-5.6 and later (OpenAI docs, read 8 Nov 2026). The static instructions plus a small tenant block may land near that, so count tokens before assuming a cache hit and check that the cache usage fields aren't both 0. Cache writes cost 1.25× input and reads 0.1× on `gpt-6-luna` (default 30-minute lifetime), so measure the break-even before claiming a saving. Read hits from the SDK's cache-read usage fields, not from estimates.
- **AI SDK versions differ from most tutorials.** Call options, tool-loop step limits and telemetry setup change between major versions, and vendor integration pages (Langfuse included) can lag behind. Write against `node_modules/ai/docs` for the installed version, not against a tutorial.
- **pg_net keeps request headers readable** in `net.http_request_queue` until it sends them (Supabase docs, read 12 Nov 2026). The reminder cron therefore sends a narrow token from Vault (`agendo_reminder_token`), never the secret key.
- **The Edge Function is Deno, outside `tsconfig`.** Check it with `deno check supabase/functions/send-reminders/index.ts`. Its pure helpers in `reminder.ts` are also run by Vitest.
- **Reminder claims are final.** `claim_due_reminders` inserts the row as it claims it, so a crash after the claim means a missed reminder, never a repeat. Scripts that call it on the shared database must first check that no real reminder is due (`db:reminder-race` does).
- **Serverless instances share no memory.** An in-memory rate limiter, breaker or cache is per instance and resets on a cold start, which is why that state lives in Redis.
- **Vercel Hobby** is non-commercial only (read 8 Nov 2026), and commercial use covers financial gain of anyone involved. A paying client means a plan change before go-live.
- **Evals and CI cost money.** `npm test` must never call a model, Twilio, Upstash or the network.
- **The Next.js block above is managed.** `next dev` rewrites it; leave the markers alone.

---

# 14. Checks to run

Run them and report the real output. Never claim a check passed without running it.

```
npm run dev          # Next.js dev server
npm run build        # production build
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit (add the script when the first task needs it)
npm test             # Vitest, free (add the script with the first test)
npm run test:e2e     # Playwright against the web chat demo
```

- `npm run typecheck`, `npm run lint` and `npm test`: always.
- `npm run build`: when routes, config or server modules change.
- `npm run dev` and click through, or `npm run test:e2e`: for UI changes.
- `eval:*` and the chaos script: only when the task is about them or the owner asks; report the cost.
- Anything that sends a WhatsApp message: only to the owner's own sandbox-joined number, and only after asking.

---

# 15. Build guide

Work the tasks in order; a task needs the ones before it. A phase starts only when the previous phase's exit check is true. If a phase runs long, cut its stretch work instead of skipping its exit check. Legend: 📝 write an implementation prompt in `prompts/` and get approval before coding (other tasks need one only if non-trivial) · 🎓 teaching moment: explain the decision and the rejected alternative in 2–3 sentences · ✋ the owner does the hand work; prepare it, then stop and hand over.

### Phase 0: Decisions that unblock everything
- **T01** Choose the business type to model first (open decision 1; recommend a barbershop or salon). Write the synthetic tenant: services with durations and prices, resources, hours, FAQ, in Spanish.
- **T02** VERIFY the WhatsApp 24-hour-window and template rules, Twilio sandbox limits and current OpenAI model IDs and prices. Record what was read and the date in `CLAUDE.md`. ✋ the owner confirms the Meta page by hand.

### Phase 1: Foundation
- **T03** 📝 🎓 Migration: schema `agendo` in the lab project, all tables from section 8, RLS on every tenant-scoped table, grants, schema exposed in API settings. Teaches multi-tenant RLS; rejected alternative: one schema per tenant.
- **T04** `lib/db` server-only client scoped to `agendo`, plus a test that tenant A cannot read tenant B through RLS, and a smoke test that a missing grant isn't mistaken for an empty result.
- **T05** `lib/cost` dated pricing table (cache writes and reads included) and `lib/models.ts`, with Vitest tests. Unverified rows are marked VERIFY.
- **T06** Model-call wrapper writing `model_calls` (JSONL from scripts). Tokens from the SDK response.
- **T07** 🎓 `lib/pii`: keyed phone hashing and redaction, with tests. Rejected alternative: plain SHA-256.
- **T08** 📝 ✋ Twilio sandbox and `api/whatsapp` webhook: signature check, dedupe, tenant lookup, per-conversation ordering, a stored message and a plain reply. The owner joins the sandbox with their own phone.
- **T09** Spanish system prompt (static first, tenant block after), explicit consent before the first model call. **Exit:** a message sent from WhatsApp is stored in Postgres and gets a reply.

### Phase 2: Booking core
- **T10** 🎓 Exclusion constraint on `bookings` with `btree_gist`, plus a test that two overlapping inserts can't both succeed. Rejected alternative: check-then-insert in code.
- **T11** 🎓 `lib/booking`: availability maths and timezone handling, pure and fully tested with an injected clock, including a DST zone.
- **T12** 📝 🎓 Tools with Zod arguments and server-side tenant scoping: `check_availability`, `create_booking`, `reschedule_booking`, `cancel_booking`, `handoff_to_human`.
- **T13** 🎓 The tool loop with a step limit and timeout; confirmation text built from tool results. Teaches tool calling with step limits.
- **T14** 📝 Web chat demo (`api/chat` + page) on the same core, with sample conversations and a Playwright test. **Exit:** a customer can book, reschedule and cancel in both channels, and a conflicting slot is rejected by the database.

### Phase 3: Cost control and reminders
- **T15** 📝 🎓 Reminders: pg_cron + Edge Function, one `reminders` row per send, template outside the 24-hour window. Teaches the window and template rules.
- **T16** 🎓 Rate limit per hashed number and per demo IP (Upstash). Rejected alternative: an in-memory limiter that serverless instances don't share.
- **T17** 🎓 Per-tenant monthly budget: atomic reserve, settle and refund, checked before every call; the demo's daily cap.
- **T18** 🎓 Prompt caching on the tenant prefix, and the exact-match FAQ response cache with invalidation. Measure the saving and record it. **Exit:** reminders send on schedule, an over-budget tenant is blocked, and the cache saving is a recorded number.

### Phase 4: Resilience
- **T19** 🎓 Retry with exponential backoff and jitter on retryable errors only, inside a total deadline.
- **T20** 🎓 Fallback chain and the static button menu (and numbered-text version). Open decision 2 is decided from measured failure and cost numbers.
- **T21** 🎓 Circuit breaker with state in Redis.
- **T22** Chaos script: revoke the key mid-conversation, record the run. **Exit:** the chaos test passes and the result is written into the README.

### Phase 5: Guardrails and evals
- **T23** 🎓 Output rules in code: price, hour, service and booking-claim checks against tenant data and tool results.
- **T24** 🎓 Prompt-injection tests and the data-not-instructions wrapping (OWASP LLM Top 10).
- **T25** Consent line, privacy policy page, retention job (pg_cron), with the "not a lawyer" note.
- **T26** 📝 Owner dashboard: conversations, bookings, cost, latency, volume, from `model_calls` and `bookings`.
- **T27** 📝 🎓 Multi-turn eval harness: simulated customers, injected clock, seeded tenant, scorer tested on its own.
- **T28** ✋ Write the 30 scenarios (the heaviest hand work; flag overruns early).
- **T29** Run the suite, commit `evals/baseline.json` in its own commit, and the GitHub Action (smoke on push, full on PRs to `main`, SHA-pinned, spend cap, skipped without the secret; ask before adding it). **Exit:** double bookings and invented prices both score 0, and the eval suite runs green in CI.

### Phase 6: Ship
- **T30** 🎓 Langfuse tracing via AI SDK telemetry, with phones and names redacted (if not already added earlier). VERIFY the free-tier limits.
- **T31** Vercel deploy (ask before env vars), live smoke test of the web chat demo.
- **T32** README: cost model, cache savings, fallback diagram, chaos-test result, eval table, all from run files.
- **T33** ✋ Case study on danielcolorado.dev and the demo video.
- **T34** ✋ Pitch one real business in Medellín (free first month for a testimonial and case-study permission). Any real data or real number only after a reviewed privacy setup.
- **T35** Check every item in the definition of done. Only now does the project leave "In the lab".

---

# 16. When in doubt

Keep it small. Read the doc instead of guessing. Measure instead of claiming. Let the database decide bookings, not the model. Treat every customer message as data. Keep keys on the server and real data out of the repo. Give the customer a usable reply even when everything upstream is failing. Save a prompt and get approval before coding. Run the checks. Share exact test steps. Teach the decision you just made.
