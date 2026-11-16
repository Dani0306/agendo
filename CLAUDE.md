@AGENTS.md

# Agendo — project context

A WhatsApp assistant that takes bookings, answers common questions and sends reminders for small businesses. The owner sees exactly what it costs. When the model provider is down or the budget is spent, it falls back to a simple button menu instead of breaking. Agendo is a working name. Stack, commands, layout, conventions and boundaries are in `AGENTS.md`; this file is the owner's context, plan and log.

This is a learning project and a portfolio piece. The audience is a hiring manager who reads the cost model, the chaos-test result and the eval table, and ideally one real business that uses it. PaperTrail (`~/dev/papertrail`) is the reference for conventions: the same `model_calls` logging, dated pricing table, run files + `baseline.json` + gate, `prompts/` workflow, and README blocks generated from run files. Classly is the reference for charging budget before a call and refunding it on failure.

**Problem.** Small businesses (barbershops, clinics, salons, tutors) run bookings by hand over WhatsApp. They answer the same questions all day, go back and forth over times, reply late after hours, and lose money on no-shows. Generic chatbots invent prices, confirm slots that don't exist, cost an unpredictable amount and stop working during outages.

**Core rule.** The AI converses, the database decides. The model never confirms a booking. The database does, after verifying the slot is free.

**Users.**
- End customers, booking over WhatsApp.
- Business owners and receptionists: the buyers.
- Recruiters and interviewers, who must be able to try it through the web chat demo without a phone number.
- Daniel, as the operator.

**Why no RAG here.** The eval project (Verdict) was skipped, and this project does not assume the RAG (CiteDesk) or agent (Triage) projects came first. So the tenant FAQ goes in a cached system prompt rather than RAG (a small-business FAQ is one or two pages, so this is the correct design at this scale), the small tool-calling loop is built here, and so is a small multi-turn eval harness.

---

## Who I am

Daniel Colorado, full stack developer in Medellín (UTC−5). Software Engineering student at IUE, full-time Back Office Agent at Third Way Health. Native Spanish, C1 English. Portfolio: danielcolorado.dev · GitHub: Dani0306.

**Already fluent, don't explain:** TypeScript, React, Next.js, Tailwind, Node, Supabase (Postgres, auth, storage, RLS, Edge Functions, pg_cron), Vercel, Git, GitHub Actions, Vitest, Playwright, OpenAI API in production, Zod and structured output (from PaperTrail), Claude Code, Resend, AI credit charging and refunding (from Classly).

**Teach these as we build** (2–3 sentences on the decision and the rejected alternative, in the prompt file and briefly in chat):

1. Prompt caching
2. Rate limiting
3. Per-tenant budgets
4. Model fallback chains
5. Retry with backoff and jitter
6. Circuit breakers
7. Tool calling with step limits
8. Multi-tenant RLS
9. Preventing double booking with a Postgres exclusion constraint
10. Timezone handling
11. Prompt injection defence
12. PII handling
13. Multi-turn conversation evals with simulated customers
14. Langfuse tracing
15. WhatsApp template and 24-hour-window rules

## Constraints

- **Time:** limited hours around a full-time job and university. Every phase is sized for short sessions; say so if one is too big.
- **Budget:** roughly $3–9/month in development; the whole roadmap under $20/month. Free tiers for everything except model calls. Prices are in "Cost model" below, once verified.
- **Supabase:** the free tier limits active projects, so Agendo uses the **shared lab project** with its own schema `agendo`, not a new project.
- **Data:** never real customer data in demos, tests, evals or traces. Synthetic conversations only. Phone numbers hashed or redacted in logs and traces.
- **Law:** Colombian personal data law (Ley 1581 de 2012) applies to customer names and phone numbers. Required: a consent line on first contact, a short privacy policy and a retention period. Daniel is not a lawyer; a real client should have the terms reviewed. **Because the first tenant is a health business, health data is sensitive data under the law: see "Health-sector rules" below.**
- **Out of scope:** payments, a native app, multi-location chains, calendar sync (Google/Outlook), RAG or a vector database, LangChain/LlamaIndex, fine-tuning.
- Everything else (stack, secrets, boundaries) is in `AGENTS.md`.

---

## Scope

**Minimum (ships):**

1. WhatsApp webhook (signature verified) and conversation state.
2. Intent handling for book, reschedule, cancel, question and talk-to-a-human. Spanish first, English fallback.
3. Booking tools that only book a slot the database has verified is free.
4. Reminders before appointments.
5. Owner dashboard: conversations, bookings, cost, latency, volume.
6. Per-tenant monthly token budget and per-number rate limit.
7. Web chat demo running the same agent.

**Stretch (only after the minimum is deployed):** self-serve tenant onboarding · semantic cache for repeated FAQ questions · cache savings on the dashboard · button-menu degradation polish · human handoff with an auto-written summary · cost per conversation on the dashboard · voice-note transcription.

## Definition of done

Not done until all of these exist:

1. Deployed URL plus a web chat demo a recruiter can try without WhatsApp
2. Public GitHub repo
3. README with the cost model, cache savings, fallback diagram and chaos-test result
4. Case study on danielcolorado.dev
5. Demo video
6. Eval suite green in CI with a committed baseline
7. Ideally, one real business using it

Until it is deployed it stays in the "In the lab" section of the portfolio. Never describe it as finished before that.

## Workflow

Phases are gated by their exit checks, not by the calendar: a phase starts only when the previous exit check is true. If a phase runs long, cut stretch goals instead of skipping its exit check. Task details are in `AGENTS.md` → 15.

**Phase 0: Decisions**

- [x] T01 Choose the business type (open decision 1); write the synthetic tenant in Spanish (`scripts/seed/tenant-fisio-demo.json`)
- [ ] T02 VERIFY WhatsApp window and template rules, Twilio sandbox limits, OpenAI model IDs and prices (✋ owner checks the Meta page by hand) (read 8 Nov, see "Platform facts"; waiting on the owner's check of Meta policy section 3)

**Phase 1: Foundation.** Exit: a message sent from WhatsApp is stored in Postgres and gets a reply. **Met on the web chat and in the database; open for free-text delivery over WhatsApp** (owner decision, 10 Nov: the trial cannot send it, and upgrading waits for a client or the demo video).

- [x] T03 📝 Migration: schema `agendo`, tables, RLS, grants, schema exposed (applied to the lab project 8 Nov; isolation test passes there)
- [x] T04 `lib/db` + cross-tenant RLS test + grant smoke test
- [x] T05 `lib/cost` dated pricing table and `lib/models.ts`
- [x] T06 Model-call wrapper writing `model_calls`
- [x] T07 `lib/pii`: keyed phone hashing and redaction
- [x] T08 📝 ✋ Twilio sandbox + webhook (signature, dedupe, tenant lookup, ordering) (inbound proven live; outbound template proven; WhatsApp free-text replies are blocked by the Twilio trial, see Platform facts)
- [x] T09 Spanish system prompt + explicit consent before the first model call (consent proven live on the web chat; the agent ran on the real model in T13)

**Phase 2: Booking core.** Exit: a customer can book, reschedule and cancel in both channels, and the database rejects a conflicting slot.

- [x] T10 Exclusion constraint + overlapping-insert test
- [x] T11 Availability maths and timezone handling (injected clock, a DST zone in tests)
- [x] T12 📝 Booking tools with Zod arguments and server-side tenant scoping
- [x] T13 Tool loop with step limit and timeout
- [x] T14 📝 Web chat demo on the same core + Playwright test

Phase 2 exit: met on the web chat, **open on WhatsApp** until the Twilio account can send free text (started early by owner decision, 9 Nov).

**Phase 3: Cost control and reminders.** Exit: reminders send on schedule, an over-budget tenant is blocked, and the cache saving is a recorded number.

- [ ] T15 📝 Reminders: pg_cron + Edge Function, templates outside the 24-hour window (built, deployed and scheduled; the live send waits on the owner's Edge Function secrets)
- [x] T16 Rate limit per hashed number and per demo IP (Upstash) (live once the owner adds the Upstash values)
- [x] T17 Per-tenant budget: reserve, settle, refund; demo daily cap
- [x] T18 Prompt caching + exact-match FAQ cache; saving measured

**Phase 4: Resilience.** Exit: the chaos test passes and the result is in the README.

- [x] T19 Retry with exponential backoff and jitter
- [x] T20 Fallback chain + button menu (closes open decision 2)
- [x] T21 Circuit breaker (state in Redis; per process in development until Upstash exists)
- [x] T22 Chaos script: revoke the key mid-conversation

Phase 4 exit: **met.** The chaos test passed and its result is in the README (12 Nov). Started before Phase 3's exit, at the owner's request.

**Phase 5: Guardrails and evals.** Exit: double bookings and invented prices both score 0, and the eval suite runs green in CI.

- [ ] T23 Output rules enforced in code
- [ ] T24 Prompt-injection tests
- [ ] T25 Consent line, privacy policy, retention job
- [ ] T26 📝 Owner dashboard
- [ ] T27 📝 Multi-turn eval harness and scorer
- [ ] T28 ✋ Write the 30 scenarios
- [ ] T29 First run, `evals/baseline.json` in its own commit, GitHub Action (ask before adding the secret)

**Phase 6: Ship.** Exit: every item in "Definition of done" exists.

- [ ] T30 Langfuse tracing, PII redacted
- [ ] T31 Vercel deploy + live smoke test of the web chat demo
- [ ] T32 README from run files
- [ ] T33 ✋ Case study and demo video
- [ ] T34 ✋ Pitch one real business in Medellín (free first month for a testimonial and case-study permission)
- [ ] T35 Check every item in the definition of done

**Session sizing note.** Phase 5 is the largest: T26–T29 hold the dashboard, the harness, the 30 hand-written scenarios and CI. Expect it to need the most sessions, and start T28 early (scenarios can be drafted by hand from Phase 2 onwards).

---

## Evaluation

Scoring rules (one tested place, run files, spend caps, baseline discipline) are in `AGENTS.md` → 12. The plan:

**Scenarios.** 30 scripted multi-turn simulated customers. Examples: changes their mind mid-booking; gives an ambiguous date ("next Tuesday"); is rude; asks something not in the FAQ; attempts prompt injection; asks for a slot that is already taken.

**Metrics.**
- Task completion rate
- Booking accuracy (the created row matches the request and the slot was truly free)
- Turns to completion
- Hallucinated-fact rate (invented prices, hours, services)
- Correct escalation rate to a human
- Injection resistance rate
- Cost per conversation and cache hit ratio
- Availability under failure (share of chaos-test conversations that still got a useful reply)

**Hard rule.** Double bookings and invented prices must be exactly 0. Any non-zero count is a failed build.

**CI.** A GitHub Action runs the suite on PRs and fails if a headline metric drops more than 2 points below the committed `evals/baseline.json`. Full suite on PRs to `main` only; a small smoke subset on every push. Skip (don't fail) when the API key secret is absent, pin actions by SHA, cap spend per run, upload the run file as an artifact. Ask before adding secrets to the repo.

---

## Working agreements

How to work (the prompt-and-approve loop, teaching rule, verifying against docs, the ask-first list) is in `AGENTS.md` → 2 and 4. Beyond that:

- Teach while building; verify against docs; never invent prices; measure before claiming an improvement.
- **Git:** small commits, conventional commit messages, a branch per task. Ask before pushing.
- Write tests alongside code (Vitest).
- Don't add dependencies, services or abstraction layers that were not asked for.
- **Ask before:** creating anything outside this repo, destructive Supabase schema changes, spending money, sending any message to a real phone number, publishing anything public.
- **Phase slips:** if a phase won't fit in the available sessions, say so in one or two sentences, then keep building under a stated assumption.
- Spanish is fine in conversation; code, comments, commits and docs in English.

---

## Decisions already made

- **The database decides bookings.** An exclusion constraint on a `tstzrange` per resource prevents double booking. Not the prompt.
- **Time:** `timestamptz` everywhere, a timezone per tenant, and the current date and timezone injected into the prompt so "next Tuesday" resolves correctly.
- **Output rules in code, not only the prompt:** never invent a price, never confirm an unavailable slot, never promise a refund. Replies are post-checked against tenant data.
- **Customer messages and tool results are untrusted data**, never instructions.
- **Budget and rate-limit checks run before each model call**, and failed calls refund the budget (Classly's credit pattern).
- **FAQ in a cached system prompt, not RAG** (see "Why no RAG here").
- **OpenAI is the only model provider** (owner decision, 8 Nov 2026: only an OpenAI key is available). Primary model `gpt-6-luna` with prompt caching on the per-tenant system prompt. ID and price read on OpenAI's pricing page, 8 Nov 2026. The earlier Anthropic plan was dropped, along with `@ai-sdk/anthropic`.
- **Development messaging:** Twilio WhatsApp Sandbox. A real WhatsApp Business number only if a client pays, and the business pays the messaging fees.
- **Supabase:** the shared lab project, schema `agendo`.
- **Degradation chain:** primary model → fallback model → static button menu → "a person will reply soon".
- **Python is not needed.** An optional notebook only, if useful for analysing eval and cost exports.

## Open decisions

Record the answer, the run or source that supports it, and the date when closed.

1. **Which business type to model first. Decided 8 Nov 2026 (T01, owner): home healthcare and outpatient clinics (physical therapy, chiropractic, dental).** The recommendation was a barbershop or salon; the owner chose health, which brings the "Health-sector rules" below. **First synthetic tenant (owner, 8 Nov): an outpatient physical therapy clinic, Fisio Aurora (demo).** Home visits wait until after the minimum is deployed.
2. **Fallback model.** With one provider the candidate is `gpt-6.1-sol`. It survives a model-specific failure but not an OpenAI-wide outage, so the chain's later steps (button menu, "a person will reply soon") carry that case, and the chaos test should model it. A second provider needs a key the owner doesn't have. Decide from measured failure and cost numbers in Phase 4 (T20). **Decided 12 Nov 2026 from the chaos run (`evals/runs/2026-11-12-chaos.json`): keep `gpt-6.1-sol` as step 2.** It served a full booking conversation when the primary model was missing, at $0.0164 per conversation, about 25× the primary. That cost applies only during a primary failure. It can't help with a revoked key or an OpenAI-wide outage; there the menu carried 100% of turns.
3. **Production messaging provider.** Twilio or Meta Cloud API directly. Decide only if a client is lined up.
4. **Default monthly budget per tenant and rate-limit thresholds.** Tune from the measured cost per conversation (Phase 3 and the first eval run). Starting values (12 Nov, T16–T17): $5 a month when `monthly_budget_usd` is null; demo cap $0.50 a day; 10 messages a minute and 100 a day per customer; 20 a minute and 200 a day per web IP. The measured conversation costs $0.00066 with caching, so $5 covers about 7,500 of them.
5. **Whether to submit a reminder template for approval early.** Read 8 Nov: the Sandbox has a built-in Appointment Reminders template and doesn't support custom templates, so development needs no approval. Recommendation: use the Sandbox template through Phase 3 and submit a custom one only when a client and a registered sender exist. Submitting needs the owner's approval.

**Parked ideas:** home visits (patient address, travel time between visits), after the minimum is deployed.

---

## Health-sector rules

Added 8 Nov 2026, because the first tenant is a health business. These are read from the sources below, not legal advice. Daniel is not a lawyer, and a real clinic must have a lawyer review them before any real patient uses Agendo.

- **Health data is sensitive data** (Ley 1581 art. 5). Processing it is prohibited unless the person gives explicit authorisation or another art. 6 exception applies. Decreto 1377 de 2013 art. 6 adds that the person must be told they aren't obliged to authorise it, which data is sensitive and what it is for. So consent is an explicit yes before the model sees anything, not a line appended to a reply.
- **Collect the minimum.** Agendo books appointments; it isn't a clinical record. It never asks for symptoms, diagnoses, medication or ID numbers. A patient may volunteer them anyway, so those messages count as health data for retention, logs and traces.
- **No clinical advice.** The assistant never diagnoses, suggests treatment or comments on symptoms. Possible emergencies get a static message with no model call and a handoff. Which number to give is VERIFY: the sources read only confirm line 123 for Bogotá.
- **Reminders don't name the treatment.** A WhatsApp preview is visible on a lock screen, so a reminder says "tu cita" with date, time and clinic.
- **Data goes to US vendors** (OpenAI, Twilio, Vercel, Langfuse by region). Ley 1581 art. 26 restricts transfers to countries without adequate protection. The SIC's list included the US since Circular 005 de 2017, and an August 2026 press report still lists it; confirm the current list before a real clinic.
- **WhatsApp policy.** Meta's policy (updated 23 Sep 2026) section 3 restricts sending or requesting health information. A search excerpt shows this applies where regulations prohibit sending it to systems without heightened safeguards, but the page read on 8 Nov returned a shortened quote. ✋ The owner reads section 3 in full; this is the one finding that could block the use case in production. Section 2 requires a clear path to a human, so `handoff_to_human` is mandatory.
- **HIPAA** applies only if a US clinic or US patients are ever involved. Langfuse's Hobby tier doesn't offer it.

Sources are copies of the law and search excerpts, read 8 Nov, not read in full: [Ley 1581](https://www.alcaldiabogota.gov.co/sisjur/normas/Norma1.jsp?i=49981) · [SIC Circular 005 de 2017](https://normas.cra.gov.co/gestor/docs/circular_superindustria_0005_2017.htm) · [August 2026 press report](https://www.asuntoslegales.com.co/actualidad/la-superindustria-avala-el-intercambio-de-datos-personales-con-mas-de-37-paises-2613831) · [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/es-la/policy/).

## Platform facts

Read from vendor pages on 8 Nov 2026 (T02).

- **Models:** `gpt-6-luna` (primary) and `gpt-6.1-sol` (fallback candidate), read on OpenAI's pricing page 8 Nov 2026.
- **Prompt caching (OpenAI):** minimum 1,024 tokens for GPT-5.6 and later. Writes cost 1.25× input (30-minute default; 12-hour lifetime costs more) and reads 0.1× (0.05× on GPT-6.1 Sol and Terra). Usage fields: `usage.input_tokens_details.cached_tokens` and `cache_write_tokens`. The pricing page itself states no minimum, so re-check the caching guide when T18 measures.
- **24-hour window:** it runs 24 hours from the customer's last inbound message. Outside it, only approved templates can be sent. Inside it, plain text and media are free-form, but **buttons and lists need a template**.
- **Sandbox:** membership expires **3 days after joining**. One message every 3 seconds. Only joined numbers receive messages. Three built-in templates (Appointment Reminders, Order Notifications, Verification Codes), no custom templates. Whether buttons work there isn't stated, so the button menu starts as numbered text.
- **Template category:** templates that don't come from an explicit user request will likely be categorised as Marketing, so the customer should ask for or agree to reminders.
- **Webhook:** Twilio's defaults are 5 s to connect, 15 s read, 15 s total, 1 retry on connection failure. The agent loop can outlast that, so the webhook should acknowledge first and send the reply through the API. The T08 prompt decides.
- **Trial accounts refuse free-text API sends** (measured 9 Nov 2026): a REST send with `Body` returned HTTP 400, code 21654, and the console's own API example sends only a `ContentSid` template. The Phase 1 webhook therefore returns static replies inline as TwiML. Twilio's trial page confirms it: "Custom message bodies, email content, and WhatsApp templates aren't available during trial" (read 10 Nov 2026). A TwiML reply was generated and returned, but Twilio's log shows no outbound message. The built-in Appointment Reminders template does send (owner proved it 10 Nov), so reminders (T15) can be tested on the trial. T13 keeps replies inline under a 12 s agent deadline. Upgrading adds a profile, an address, a starting balance and payment details (the page states no minimum) and waits for a client or the demo video.
- **Signature:** computed over the exact configured URL plus all form parameters sorted by name. Leave any `#` override fragment out when validating.
- **Vercel Hobby:** non-commercial only. Commercial covers financial gain of anyone involved, including receiving payment to create or host the site. Check with Vercel Support or move to Pro before a paying client.

## Cost model

Read from vendor pages on the dates shown. The dated table in `lib/cost` is the source of truth once it exists. Never fill a row from memory.

| Item | Price or limit | Read on |
| ---- | -------------- | ------- |
| `gpt-6-luna`, prompts ≤ 272k tokens, per 1M | input $0.10 · cached input $0.01 · cache write (30 min) $0.125 · output $0.50 | 8 Nov 2026 |
| `gpt-6-luna`, prompts > 272k tokens, per 1M (won't apply here) | input $0.20 · cached $0.02 · write $0.25 · output $0.75 | 8 Nov 2026 |
| `gpt-6.1-sol` (fallback candidate, open decision 2), per 1M | input $2.00 · cached $0.10 · write (30 min) $2.50 · output $10.00 (above 272k: $4 / $0.20 / $5 / $15) | 8 Nov 2026 |
| Twilio WhatsApp Sandbox | VERIFY: the pages read don't state its price | — |
| WhatsApp in production (paid by the business), Twilio fee | $0.005 per message, inbound or outbound; $0.001 per failed message ("current as of September 2026") | 8 Nov 2026 |
| WhatsApp in production, Meta fee | calculator shows $0.0034 per utility template outside the window; no Meta charge for utility inside it. VERIFY the Colombia rate card | 8 Nov 2026 |
| Upstash Redis free tier | 500K commands/month · 250 MB (the page also says 256) · 10 GB bandwidth · 1 database | 8 Nov 2026 |
| Langfuse Cloud Hobby | 50k units/month · 30 days of data access · 2 users · client-side masking included · no HIPAA | 8 Nov 2026 |
| Resend free tier | 3,000 emails/month · 100/day · 3 domains | 8 Nov 2026 |
| Supabase Edge Functions, free | 150 s wall clock · 2 s CPU per request · 100 functions. VERIFY invocation quota and pg_cron limits | 8 Nov 2026 |
| Vercel Hobby | $0, non-commercial only · 1M invocations · 4 h active CPU · 100 GB transfer per month | 8 Nov 2026 |

Back-of-envelope figures (cost per conversation, per eval run) go here only after T05, computed from the table, and are replaced by measured values as soon as runs exist.

**Measured (12 Nov 2026, `evals/runs/2026-11-12-cache-ab.json`):** one scripted conversation is 7 calls (a question, then book, reschedule and cancel) on `gpt-6-luna`. With prompt caching off it cost $0.00183; with it on, $0.00066. That's **64.1% less per call**, with 82.5% of prompt tokens read from the cache. Median call latency went from 2.0 s to 1.4 s.

## Reference docs

Link-checked by the owner before 7 Nov 2026. Agents still fetch the page before writing code against it.

- Twilio WhatsApp sandbox — https://www.twilio.com/docs/whatsapp/sandbox
- Supabase Cron — https://supabase.com/docs/guides/cron
- Supabase Edge Functions — https://supabase.com/docs/guides/functions
- Row-level security — https://supabase.com/docs/guides/database/postgres/row-level-security
- Upstash Redis — https://upstash.com/docs/redis/overall/getstarted
- OpenAI prompt caching — https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI pricing — https://developers.openai.com/api/docs/pricing
- OpenAI models — https://developers.openai.com/api/docs/models
- OpenAI rate limits and tool use: find the pages under https://developers.openai.com/api/docs when T16 and T12 need them
- AI SDK tools — https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- AI SDK telemetry — https://ai-sdk.dev/docs/ai-sdk-core/telemetry
- Streaming on Vercel — https://vercel.com/docs/functions/streaming
- Langfuse + AI SDK — https://langfuse.com/integrations/frameworks/vercel-ai-sdk
- OWASP Top 10 for LLM apps — https://genai.owasp.org/llm-top-10/
- Eval fundamentals — https://hamel.dev/blog/posts/evals/
- Meta WhatsApp Cloud API docs — blocked the automated link check. Open and confirm by hand before relying on them.

---

## Project log

Keep this current. Append one line per working session: date, what shipped, the numbers, what is next. It is the raw material for the case study.

- **2026-11-07** — Phase 0, context files written, nothing built. Next.js 16.4.5 scaffolded at the repo root (TypeScript, Tailwind, ESLint, App Router, `src/`); `AGENTS.md` and `CLAUDE.md` written from the project brief, using CiteDesk's files as the template. $0 spent. Next: T01 (business type and synthetic tenant), then T02 (verify WhatsApp rules, model IDs and prices).
- **2026-11-08** — Phase 0 in progress. T01: owner chose home healthcare and outpatient clinics over the recommended barbershop, so health-sector rules were added (explicit consent first, data minimisation, no clinical advice, neutral reminders). T02: model IDs, prices and platform limits read from vendor pages and recorded. Haiku 5.5 is $0.10/$0.50 per 1M and caches from 512 tokens; the Sandbox expires after 3 days and offers no custom templates; buttons need templates; Twilio's webhook timeout is 15 s. T01 closed with the synthetic tenant Fisio Aurora (demo), an outpatient physio clinic; home visits parked. No code; $0 spent. Next: owner reads Meta policy section 3 to close T02, then T03.
- **2026-11-08 (Phase 1, prompt 001)** — T03–T09 built on four stacked local branches. Thirteen `agendo` tables with composite tenant foreign keys, member-only read policies and a column grant hiding phone data; the migration and isolation script pass on PGlite, and the script caught a deliberately broken policy. Dated price table, `recordCall`, keyed phone hash, AES-256-GCM phone storage, signed webhook, consent gate (nothing stored before consent but the literal answer), and a per-conversation lease. 103 tests; forged and unsigned POSTs get 403 on the built route. No model calls; $0 spent. Next: owner applies the migration, joins the Sandbox and runs the exit check.
- **2026-11-08 (OpenAI only)** — Owner confirmed Agendo uses only an OpenAI key. Dropped `@ai-sdk/anthropic` for `@ai-sdk/openai` 4.0.111; `gpt-6-luna` is primary and `gpt-6.1-sol` the fallback candidate. Pricing table rewritten from OpenAI's page (272k long-prompt tier instead of 100k); prompt cache minimum is 1,024 tokens, not 512. The fallback now shares the primary's provider, so the chaos test must cover an OpenAI-wide failure. 103 tests pass. A real Supabase key had been pasted into `.env.example`; it never reached a commit and now lives in `.env.local`. $0 spent.
- **2026-11-09 (Phase 2, prompt 002)** — T10–T14 built on three stacked local branches, started before Phase 1's exit check by owner decision. Exclusion constraint live on the lab project (10 parallel inserts: 1 accepted, 9 `23P01`); availability maths with DST tests; six tools scoped by the server; hand-written tool loop (5 calls, 12 s or 25 s deadline, one write per turn, confirmations built from the row); emergency check before any model call; web chat on the same core. Live smoke on `gpt-6-luna`: booked, rescheduled and cancelled for $0.000676 in 7 calls, median 2.0 s. 215 unit and 8 Playwright tests pass. WhatsApp delivery is still unproven (Twilio trial). Next: settle Twilio, then Phase 3.
- **2026-11-10 (Phase 1 closed on the web chat)** — Owner ran the database check, sent the Appointment Reminders template to their own phone (arrived) and completed consent and a reply on the web chat. Twilio's trial page confirms trial accounts can't send custom message bodies, so free-text WhatsApp replies stay unproven until the account is upgraded. T03–T09 ticked with that caveat. $0 spent. Next: Phase 3 (T15 reminders on the built-in template, T16 rate limits, T17 budgets, T18 caching).
- **2026-11-12 (Phase 3, prompt 003)** — T15–T18 built on three stacked branches. Reminders: a claim function, a Deno Edge Function deployed with a token check, and a pg_cron job every 10 minutes (pg_cron, pg_net and two Vault secrets added outside `agendo` with approval); 4 overlapping claims over 6 due bookings returned 6 distinct reminders. Budget: atomic reserve, settle and refund; 10 parallel $0.30 reservations against $1.00 let 3 through, and a $0 tenant got the static reply with no model call. Rate limits in Upstash, failing open. Exact-match FAQ cache for first questions only. Prompt-caching A/B: 64.1% cheaper per call, 82.5% of prompt tokens cached, median 2.0 s → 1.4 s, $0.0025 for both arms. 258 unit and 9 Playwright tests. Exit check: over-budget block and cache saving met; the reminder send waits on the owner's Edge Function secrets, and rate limits on Upstash values. Next: owner hand steps, then Phase 4.
- **2026-11-12 (Phase 4, prompt 004)** — T19–T22 built on three stacked branches, started before Phase 3's exit by owner request. Retries only on 408, 429, 5xx and network errors, with full jitter inside the turn deadline. A circuit breaker per model (3 failures in 60 s, 30 s cool-down, one probe) in Redis, in memory without Upstash. Fallback chain `gpt-6-luna` → `gpt-6.1-sol` → numbered menu from tenant data → "a person will reply soon". Chaos run on the real API passed all 5 checks: 100% availability with the key revoked (breakers then skipped both models: 0 calls), with the primary missing (the full booking ran on the fallback for $0.0164), and on recovery after the probe; $0.0172 total. Open decision 2 closed: keep `gpt-6.1-sol`. Found: turns take 3–4 s of Supabase round trips even with no model call. 316 unit and 10 Playwright tests. Next: owner's Phase 3 hand steps (Edge Function secrets, Upstash), then Phase 5.
