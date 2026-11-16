# Agendo

A WhatsApp assistant that takes bookings, answers common questions and sends reminders for small clinics. The model converses; the database decides: a booking exists only when Postgres accepted the row, and an exclusion constraint makes a double booking impossible.

**Status: in the lab, not deployed.** It runs against a synthetic clinic (Fisio Aurora, demo) with synthetic conversations only. The full README (cost model, cache savings, fallback diagram, eval table) comes with the deploy.

## Resilience

When a model call fails, the customer still gets a useful reply:

1. **Primary model** (`gpt-6-luna`), with retries on temporary errors only (408, 429, 5xx), exponential backoff with full jitter, inside the turn's deadline.
2. **Fallback model** (`gpt-6.1-sol`) when the primary fails or its circuit breaker is open.
3. **A numbered menu** built from the clinic's own data (services and prices, hours, FAQ, talk to a person), with no model call.
4. **"A person will reply soon"**, only if even the clinic's data can't be read.

A circuit breaker per model opens after 3 failures in 60 seconds, so later messages skip a dead model at once instead of waiting for it to fail again. After 30 seconds it lets one probe through. Its state lives in Redis, because serverless instances share no memory.

The numbers below are generated from the newest chaos run file by `npm run readme`, never typed by hand.

<!-- chaos:start -->
**Chaos test** — passed, run 2026-11-12 ([run file](evals/runs/2026-11-12-chaos.json)).

Primary `gpt-6-luna`, fallback `gpt-6.1-sol`, then a numbered menu built from the clinic's own data.

| Scenario | Availability under failure |
| --- | --- |
| A. Key revoked mid-conversation (real 401s) | 100% |
| B. Primary model missing (real 404s) | 100% |
| C. Key restored, breaker probe | 100% |

| Phase | Customer wrote | Reply | Model calls | Latency |
| --- | --- | --- | --- | --- |
| A: real key | ¿Cuánto cuesta la valoración inicial? | answer (gpt-6-luna) | 1 | 7188 ms |
| A: real key | ¿Atienden los sábados? | answer (gpt-6-luna) | 1 | 6535 ms |
| A: revoked | Quiero agendar una valoración el próximo martes a las 10 de la mañana. | menu | 2 | 5537 ms |
| A: revoked | ¿Dónde están ubicados? | menu | 2 | 6206 ms |
| A: revoked | ¿Tienen parqueadero? | menu | 2 | 5679 ms |
| A: revoked | 2 | menu | 0 | 4208 ms |
| A: revoked | ¿Y atienden por EPS? | menu | 0 | 3795 ms |
| C: restored | ¿Cuánto cuesta una sesión de fisioterapia? | answer (gpt-6-luna) | 1 | 7726 ms |
| C: restored | Gracias, ¿y dónde están ubicados? | answer (gpt-6-luna) | 1 | 6381 ms |

Scenario B: 3 calls to the missing model before its breaker opened, 7 served by the fallback, $0.0164 for the whole booking conversation.

- ✅ Every turn got a useful reply while the key was revoked
- ✅ Once the breakers opened, a turn made no model calls
- ✅ A menu choice was answered with no model
- ✅ A full booking ran on the fallback when the primary model was missing
- ✅ After the cool-down the primary served again

Total cost of the run: $0.0172.
<!-- chaos:end -->

## Running it

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev                  # web chat demo at http://localhost:3000
npm test                     # unit tests, free, no network
npm run test:e2e             # Playwright against the web chat
npm run chaos                # the chaos test: real API calls, about $0.02
```

Health data is sensitive under Colombia's Ley 1581 de 2012. The consent text and privacy terms here are drafts; the author is not a lawyer, and a real clinic must have them reviewed before any patient uses this.
