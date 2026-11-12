# 004 — Phase 4: Resilience (T19–T22)

**Status:** approved
**Branches:** `feat/t19-t21-retry-breaker` → `feat/t20-fallback-menu` → `feat/t22-chaos`, stacked on `feat/t18-caching` (PR #3 is still open)
**Phase:** 4 (see `CLAUDE.md` → Workflow)

## Goal

When a model call fails, the customer still gets a useful reply. A failed call is retried only if the error is temporary. A broken model is skipped for a while instead of failing every message. When no model can answer, a numbered menu built from the tenant's own data takes over. A chaos run that revokes the key mid-conversation proves it, and the result goes in the README from its run file.

**Exit check (from `CLAUDE.md`):** the chaos test passes and the result is in the README.

## Starting before Phase 3's exit check

Phase 3's exit is open on one item: a reminder sent on schedule, which waits on the owner's six Edge Function secrets. The owner asked for Phase 4 on 12 Nov 2026. Phase 4 touches nothing in the reminder path, so the two don't conflict.

## Session sizing

This doesn't fit one short session. It splits at three stopping points, each leaving the repo green:
1. T19 and T21, the pure retry and breaker modules with their tests.
2. T20, the fallback chain and the menu, wired into the loop.
3. T22, the chaos run and the README block.

## Docs read (12 Nov 2026)

- `node_modules/ai` (7.0.165): `APICallError` is exported from `ai` with `statusCode` and `isRetryable`. `generateText` retries on its own through `maxRetries`, which stays 0 so this code owns every attempt and its log row.
- `node_modules/@ai-sdk/openai/docs/03-openai.mdx`: `createOpenAI({ apiKey })` builds a provider with its own key. The chaos run uses that to send a revoked key to OpenAI for real.
- `CLAUDE.md`:
  - The degradation chain is primary model → fallback model → button menu → "a person will reply soon".
  - Open decision 2: `gpt-6.1-sol` is the only fallback candidate. It shares the key and the provider, so a revoked key or an OpenAI-wide outage takes it down too.
  - Buttons need a template, so the menu is numbered text.
- Cost model: `gpt-6.1-sol` is $2.00 input, $0.10 cached, $2.50 cache write and $10.00 output per 1M tokens. That is 20× `gpt-6-luna`.

## Code inspected

- `src/lib/agent/loop.ts`: one `recordCall` per model call, with a budget reserve, settle or refund around it. Every degraded path ends in `PERSON_SOON_TEXT`, and over budget ends in `OVER_BUDGET_TEXT`.
- `src/lib/agent/handle-inbound.ts`: the gate before the agent (consent, handoff, emergency, rate limit).
- `src/lib/db/conversations.ts`: `saveReply` stores the trace tools in `messages.tool_calls`, which is how the next message can know a menu was just shown.
- `src/lib/guard/redis.ts`: Upstash is optional in development, and `next start` refuses to run without it.

## Decisions and assumptions

### T19 retry

- **When to retry:** only on 408, 429, 5xx, or a network error with no status code. A 400, 401, 403 or 404 never gets better on retry, so it fails over at once.
- **Backoff:** exponential with full jitter. The wait is a random value between 0 and `min(2 s, 250 ms × 2^attempt)`, for at most 3 attempts per model.
- **Deadline:** an attempt starts only if the wait plus 1 second still fits the turn's deadline.
- **What is retried:** only model calls. Tool calls are never retried, so a write can't run twice.
- **Logging and budget:** each attempt is its own `model_calls` row with its own budget reservation, settled or refunded.

### T21 circuit breaker

- **One breaker per model.** After 3 failures within 60 seconds it opens for 30 seconds. Then one probe call is let through (a lock that lasts 10 s). A success closes the breaker; a failure opens it again.
- **What counts:** only provider failures (after retries) count against the breaker. The turn's own deadline doesn't.
- **State lives in Redis** (Upstash), because serverless instances share nothing. Keys are `agendo:cb:<model>:*`.
- **Without Upstash, in development:** an in-memory breaker with a warning. It's per process, so fine for a script, wrong for a deploy. `next start` already refuses to serve without Upstash.
- **On a Redis error,** the breaker lets the call through. A broken breaker shouldn't take the agent down with it.

### T20 fallback chain and menu

- **The chain:** `gpt-6-luna`, then `gpt-6.1-sol`. Each `model_calls` row records `chain_step` (0 or 1).
- **When the fallback is used:** when the primary's breaker is open, or its retries end in failure.
- **Reservation cost:** a reservation is priced at the model actually used, so a `gpt-6.1-sol` reservation is 20× larger.
- **The menu** takes over when every model fails, when the budget is spent, or when the deadline or step limit hits.
  - It's numbered text, not buttons: (1) services and prices, (2) hours, (3) frequent questions, (4) talk to a person.
  - Each answer comes from the tenant's rows, with no model call.
  - The prompt and the menu share one money formatter, so their prices can't drift apart.
- **Menu replies.** A reply of `1` to `4` right after a menu is answered from the menu, even once the models are back. The menu marks itself `menu → shown` in the stored trace. Choice 4 hands the conversation to a person. Booking needs the model, so the menu says to choose 4 or write again later.
- **"A person will reply soon"** is the last step. It's used only when the tenant's data itself can't be loaded, because then even the menu can't be built.
- **Open decision 2 is closed by measurement in T22,** using two numbers:
  1. the fallback's cost per conversation (one scripted conversation forced onto `gpt-6.1-sol`);
  2. whether it rescues the revoked-key case, which it can't, since it uses the same key.

  Recommendation, to be confirmed by those numbers: keep `gpt-6.1-sol` for model-specific failures, because the menu already carries a provider-wide failure.

### T22 chaos

`npm run chaos` runs three scenarios against the real core and the real API, each a fresh synthetic visitor:

- **A, revoked key mid-conversation:**
  1. Two turns on the real key.
  2. The provider swaps to a revoked key, so OpenAI really returns 401.
  3. Three more turns.
  4. A menu choice.

  Expected: every turn gets a useful reply, the breakers open, and later turns skip the dead models without waiting.
- **B, primary model gone:** the primary points at a model id that doesn't exist (a real 404 from OpenAI). The booking conversation should run entirely on the fallback, which also gives the fallback's real cost for open decision 2.
- **C, recovery:** after A, with the real key back, the breaker cools down (the run waits for its 30 s), a probe succeeds, and the primary serves again.

**The metric** is availability under failure: the share of turns that got a useful reply. A useful reply is a model answer, a menu, or a menu answer. A "person will reply soon" or no reply counts as not useful.

**Output.** The run writes `evals/runs/<date>-chaos.json`. `npm run readme` renders the chaos block in `README.md` between markers, from the newest chaos run file. The README gets a short Agendo header in place of the Next.js scaffold text; the full README is T32.

## What this teaches

- **Retry with backoff and jitter (T19).** Retry only what can recover, wait longer each time, and randomise the wait so many clients don't retry in lockstep. Everything stays inside the turn's deadline. Rejected: the SDK's built-in retries, which hide each attempt from `model_calls` and know nothing of the webhook's 15 seconds.
- **Circuit breakers (T21).** After repeated failures, stop calling a broken dependency for a while, then test it with a single probe. Rejected: retrying on every message, which makes each customer wait through the same failures and spends money on calls that can't succeed.
- **Model fallback chains (T20).** A second model covers a failure of one model; a deterministic menu covers losing the provider entirely. Rejected: a fallback model as the only safety net, since with one provider and one key it fails at the same moment as the primary.

## Files to touch

- `src/lib/resilience/{retry,breaker,chain,menu}.ts` + tests — create.
- `src/lib/agent/{loop,handle-inbound,reply,runtime,prompt}.ts` + tests, `src/lib/db/conversations.ts`, `src/lib/models.ts`, `src/app/chat-demo.tsx`, `e2e/chat.spec.ts` — edit.
- `scripts/chaos.ts`, `scripts/readme.ts`, `scripts/lib/scripted-conversation.ts`, `package.json`, `README.md` — create and edit.
- `CLAUDE.md`, `AGENTS.md` — edit.

## Requirements

1. A 401, 403, 404 or 400 is never retried. A 429 or 5xx is retried at most twice more, with jittered waits, and never past the deadline.
2. Each attempt is one `model_calls` row with its `chain_step`. A failed attempt refunds its reservation.
3. Three provider failures within 60 s open that model's breaker. While it's open, that model gets no calls. After the cool-down, exactly one probe goes through.
4. When every model fails, the customer gets the menu within the deadline. A menu reply is answered from tenant data with no model call.
5. No path leaves the customer without a reply. "A person will reply soon" appears only when the tenant's data can't be loaded.
6. The chaos run file shows the availability for each scenario. The README block is generated from it, never typed by hand.

## Security, PII and data safety

- **The revoked key** is a fixed fake string in the chaos script, and it's never stored.
- **Error messages** go through `redactPhones` before reaching logs or `model_calls`, and keep only the status code.
- **Synthetic data:** chaos visitors are synthetic and removed afterwards, and their `model_calls` rows stay as the cost record.
- **Menu answers** contain only tenant data: services, prices, hours and the FAQ.

## Cost impact

- **Scenario A:** about 2 real calls, then failures (401s cost nothing).
- **Scenario B:** about 7 calls on `gpt-6.1-sol`, estimated at about $0.01 to $0.02 from the 8 Nov prices.
- **Scenario C:** about 1 to 3 calls on `gpt-6-luna`.
- **Total:** about $0.03, with a **$0.10 stop**.
- **Redis:** the breaker adds 1 to 3 Redis commands per model call once Upstash exists.

## Acceptance criteria

- [ ] Unit tests cover the retry classes and the deadline, the breaker's state changes and fail-open, the chain order with an open breaker, and the menu replies.
- [ ] The chaos run passes. A and B are at 100% availability, and C ends with the primary serving again.
- [ ] The README holds the generated chaos block.
- [ ] Open decision 2 is closed in `CLAUDE.md` with the measured fallback cost.
- [ ] typecheck, lint, unit tests, Playwright and build pass.

## Checks

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`
- `npm run chaos` (once), `npm run readme`

## Manual test steps

Filled in when the work is done.

## Results

Filled in after the work.
