# 002 — Phase 2: Booking core (T10–T14)

**Status:** approved
**Branches:** `feat/t10-t11-booking-rules` → `feat/t12-t13-agent` → `feat/t14-web-chat`, stacked on `chore/openai-only`
**Phase:** 2 (see `CLAUDE.md` → Workflow)

## Goal

A customer can book, reschedule and cancel in plain Spanish through one agent, and Postgres rejects a conflicting slot. The web chat demo runs that agent end to end. WhatsApp runs the same code.

## Starting before Phase 1's exit check

The workflow says a phase starts only when the previous exit check is true. The owner decided on 9 Nov 2026 to start Phase 2 and finish Phase 1 later. Phase 1's exit is blocked on Twilio: inbound messages are stored and a reply is generated, but the trial account does not deliver free text (REST send: HTTP 400, code 21654; TwiML reply: no outbound message appears).

**Consequence for this phase's exit check.** "Both channels" can only be half proven here. The web chat is tested live. WhatsApp is tested with unit tests up to the reply object, and stays unproven on a real phone until the Twilio question is settled. T10–T14 stay unticked for WhatsApp in the log until then.

## Session sizing

This does not fit one short session. It splits at three stopping points, each leaving the repo green: T10–T11 (database rule and pure maths), T12–T13 (tools and agent), T14 (web chat). Assumption: all three are built in order, one branch each.

## Docs read

- `node_modules/ai/docs` (7.0.165): `isStepCount` and `stopWhen`; tools without `execute` are returned to the caller; `ToolResultPart` with `output: { type: "json", value }`; `MockLanguageModelV4` from `ai/test`; `timeout` and `abortSignal` on `generateText`.
- `node_modules/@ai-sdk/openai/docs/03-openai.mdx` (4.0.111): `parallelToolCalls`, `store` (defaults to `true`), `reasoningEffort`, `textVerbosity`.
- `CLAUDE.md`, `AGENTS.md` §§ 5, 7, 8, 9, 10, 13.
- Supabase `list_extensions` on the lab project, 9 Nov 2026: `btree_gist` 1.7 is available and not installed. Other extensions live in schema `extensions`.

## Code inspected

- `supabase/migrations/20261108120000_foundation.sql`: `bookings` has the `[)` check and composite foreign keys, and no exclusion constraint yet.
- `src/lib/agent/handle-inbound.ts`: consent gate, lease, `acknowledge` is the placeholder the agent replaces. `processOne` needs a phone, which a web customer doesn't have.
- `src/lib/agent/prompt.ts`: static part first, tenant block after, `wrapCustomerMessage`.
- `src/lib/calls/record-call.ts`: one row per wrapped call, so the loop must wrap each model call separately.
- `src/lib/db/conversations.ts`: hard-codes `channel: "whatsapp"`.
- `src/lib/db/unwrap.ts`: `DbError.code` carries the Postgres code, so `23P01` is readable.
- `src/app/api/whatsapp/route.ts`: inline TwiML, 15 s limit.

## Decisions and assumptions

**Database**
- Install `btree_gist` in schema `extensions`, Supabase's convention. **This is the one change outside `agendo`.** Extensions are database-wide, and `extensions` isn't exposed through the API, unlike `agendo`, which would publish the extension's functions there. It adds nothing PaperTrail can see or depend on.
- `create_booking` is one `INSERT` and `reschedule_booking` is one `UPDATE`. A single statement is already a transaction, so no RPC function is needed, and a failed reschedule leaves the old slot intact.

**Booking rules**
- Timezone conversion uses `Intl` only, no new dependency. A nonexistent local time (DST gap) and an ambiguous one (DST fold) are both rejected, and the customer is asked to choose another time.
- Slots start every 30 minutes from opening time, and the service must end by closing time. Assumption: the owner can change `SLOT_STEP_MINUTES` later.
- The FAQ's 12-hour cancellation notice is a request ("te pedimos"), so it isn't enforced in code.

**Tools**
- A sixth, read-only tool, `my_bookings`, is added to the five in `AGENTS.md`. Without it the agent can't answer "¿cuándo es mi cita?" or tell two bookings apart before cancelling.
- `cancel_booking` and `reschedule_booking` take a local date and optional time, never an id. The server looks only among this customer's upcoming bookings. Zero or several matches returns the list instead of acting.
- If the customer names no therapist, the server tries each free one in order and moves on after a `23P01`.
- At most one write per turn. A second write call in the same turn is refused, which limits what a prompt injection can do.

**Agent loop**
- A hand-written loop around `generateText`, tools without `execute`, instead of the SDK's `stopWhen`. Each model call then gets its own `model_calls` row, and the loop can stop right after a write.
- After a successful write the loop ends with **no further model call**. The reply is built by code from the database row, so the model can't misstate a confirmation, and one call is saved.
- Limits: 5 model calls per turn. Total deadline 12 s on WhatsApp (Twilio's 15 s) and 25 s on web. SDK retries are off (`maxRetries: 0`) until T19.
- Hitting a limit, or any model error, sends the last step of the degradation chain: a static "una persona te responderá pronto". The fallback model and the menu come in T20.
- `providerOptions.openai`: `store: false` (health-related text shouldn't sit in OpenAI's response storage), `parallelToolCalls: false`, low reasoning effort for latency. Assumption: the live smoke run confirms `gpt-6-luna` accepts these. If it doesn't, I'll report it and adjust.
- History is the last 20 stored messages, customer and assistant text only. Customer text is wrapped with `wrapCustomerMessage`.
- The tenant block gains a 14-day calendar (date and weekday), so "el próximo martes" doesn't depend on the model's weekday arithmetic.

**Safety that must exist before a model is called**
- Emergency check before the agent: a Spanish and English phrase list gives a static message, a handoff and no model call. The message gives no phone number, because only line 123 for Bogotá was verified. False positives are acceptable: the cost is that a person reads the chat.
- Handoff status stops the agent. Later messages are stored and get a static acknowledgement. Until the dashboard (T26), release is a manual SQL update. The web demo's "restart" button starts a new session.

**Channels**
- A `Reply` object (`text`, optional `booking`, optional `alternatives`, optional `degraded`, `trace`) comes out of the core. WhatsApp uses `text`; web renders the rest as evidence.
- Both routes use one inline handler that collects replies.
- Web identity: a random id in an httpOnly cookie, keyed-hashed into `customers.phone_hash`, no phone stored, `channel: "web"`.
- The web demo uses the tenant whose `receiving_number` is `DEMO_RECEIVING_NUMBER`.
- Consent works the same on web: the customer types ACEPTO.
- `api/chat` returns 404 unless `DEMO_CHAT_ENABLED=1`. It has no rate limit or daily cap until T16 and T17, so this keeps it off any deploy until then. It is on in `.env.local`, so **the public tunnel exposes it while running**. Stop the tunnel when not testing.
- Playwright stubs `/api/chat` and tests rendering of each state, so it costs nothing. The real path is covered by the core's unit tests and the live smoke run. `@ai-sdk/react` isn't needed for a request and response chat, so it isn't added.

**Not built here:** budget and rate limits (T16–T17), output rules (T23), retry and fallback (T19–T21). The agent must not go in front of real users before those. Nothing is deployed in this phase.

## What this teaches

- **Exclusion constraint (T10).** Postgres refuses two overlapping `confirmed` ranges for one resource, atomically, under any concurrency. Rejected: check-then-insert in application code, where two requests can both read "free" before either writes.
- **Timezones (T11).** Store instants as `timestamptz`, convert at the edge with the tenant's IANA zone, and refuse local times that don't exist or occur twice. Rejected: fixed offsets like `-05:00`, which work in Colombia and break the first time a tenant is in a DST zone.
- **Tool calling with step limits (T12–T13).** The model only requests; the server scopes, validates and executes, and a hard cap ends the loop. Rejected: letting the SDK auto-run tools, because that gives one log row for many calls and no way to stop right after a write.

## Files to touch

- `supabase/migrations/20261109120000_booking_exclusion.sql` — create — `btree_gist` and the constraint.
- `supabase/tests/booking_exclusion.sql` — create — rolled-back SQL test.
- `scripts/db-race.ts`, `package.json` — create, edit — parallel inserts against the lab project.
- `src/lib/booking/{timezone,availability}.ts` + tests — create — pure maths with an injected clock.
- `src/lib/tools/*` + tests — create — the six tools and their Zod arguments.
- `src/lib/db/{bookings,agent-data}.ts` — create — tenant-scoped queries.
- `src/lib/db/conversations.ts` — edit — channel parameter, nullable phone, tool log, lease renewal, handoff status.
- `src/lib/agent/{loop,reply,emergency}.ts` + tests — create — loop, reply object and confirmation text, emergency check.
- `src/lib/agent/{prompt,consent,handle-inbound,runtime}.ts` + tests — edit.
- `src/lib/channels/web.ts`, `src/app/api/chat/route.ts`, `src/app/api/whatsapp/route.ts` — create, edit.
- `src/app/page.tsx`, `src/app/chat-demo.tsx`, `src/app/layout.tsx` — edit, create — the demo page.
- `playwright.config.ts`, `e2e/chat.spec.ts` — create.
- `scripts/agent-smoke.ts` — create — one scripted conversation against the real model.
- `.env.example`, `.gitignore`, `CLAUDE.md`, `AGENTS.md` — edit.

## Requirements

1. The constraint is `exclude using gist (resource_id with =, during with &&) where (status = 'confirmed')`.
2. `npm run db:race` fires 10 parallel inserts for one slot: exactly 1 succeeds and 9 fail with `23P01`. Its synthetic rows are removed afterwards.
3. Availability subtracts confirmed bookings and closed dates, and excludes past slots. Tests inject the clock and cover `America/Bogota` and `America/New_York` across both DST changes.
4. `tenantId` and `customerId` come from the server, never from tool arguments. No tool accepts an id.
5. `23P01` returns `slot_taken` with alternatives, never an error.
6. Past times, closed days, times outside hours and ambiguous times return a typed refusal without touching the database write path.
7. Every model call writes one `model_calls` row, including failed and timed-out calls.
8. Confirmations state service, therapist, day, date, time and timezone, built by code from the row.
9. A customer can't see or change another customer's booking; tests prove it.
10. Before consent, no model call happens and only the literal answer is stored, as in Phase 1.
11. Messages in one conversation are still handled one at a time, and the lease is renewed before each message.

## Security, PII and data safety

- Keys stay server-side: every new module that touches the database or the model is server-only, and the browser only calls `/api/chat`.
- Data is synthetic: tests, the race script and the smoke run use invented customers and remove them afterwards.
- Phones and health data: no phone goes to the model, logs or tool results. Errors pass through `redactPhones`. Tool results carry no customer identifiers. `store: false` on model calls. The prompt keeps rules against asking for symptoms and giving clinical advice.
- Customer text is wrapped as data, and the tools enforce every limit, so a successful injection can at most produce wrong text.

## Cost impact

- `npm test` and Playwright: no model calls.
- Live smoke run: one conversation of about 4 turns on `gpt-6-luna`. Estimated from the 8 Nov prices at 4k input tokens per call and 10 calls: about $0.005. It runs once, with a $0.05 stop.
- Expected agent cost: about $0.001 per customer turn before caching. To be replaced by measured values from `model_calls`.

## Acceptance criteria

- [ ] The rolled-back SQL test passes on the lab project: overlap rejected, back-to-back allowed, other resource allowed, cancelled slot reusable.
- [ ] `npm run db:race` reports 1 success and 9 `23P01`.
- [ ] Unit tests cover DST gap and fold, availability, tool scoping, `slot_taken` alternatives, one write per turn, the step limit, the deadline, the emergency path and handoff.
- [ ] The smoke run books, reschedules and cancels through the real model, each checked against database rows.
- [ ] Playwright passes for the confirmed, rejected and degraded states.
- [ ] Security advisor reports nothing new.

## Checks

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`
- `npm run db:race`, `npm run agent:smoke` (once)

## Manual test steps

Filled in with exact steps when the work is done.

## Results

Filled in after the work.
