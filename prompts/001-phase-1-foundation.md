# 001 — Phase 1: Foundation (T03–T09)

**Status:** approved
**Branch:** one per slice: `feat/t03-t04-schema`, `feat/t05-t07-plumbing`, `feat/t08-whatsapp-webhook`, `feat/t09-prompt-consent`
**Phase:** 1

## Goal

A WhatsApp message sent to the Twilio Sandbox is verified, stored in schema `agendo` and answered. A first-time sender gets the consent request before anything else is stored. Cost, model-call and phone-handling plumbing exist and are tested, ready for the agent in Phase 2.

This phase makes **no model calls**. Replies are static text.

## Sizing

Too big for one session. It splits into four slices, each one session and one PR:

| Slice | Tasks | Stops for you? |
| ----- | ----- | -------------- |
| 1 | T03, T04 | Yes: paste the migration, expose the schema |
| 2 | T05, T06, T07 | No |
| 3 | T08 | Yes: Twilio Sandbox, tunnel, your phone |
| 4 | T09 | Yes: the exit check |

## Docs read (8 Nov 2026)

- [Supabase custom schemas](https://supabase.com/docs/guides/api/using-custom-schemas.md) — expose the schema in API settings, grant to roles, `db: { schema }`. The doc grants ALL to `anon`; we grant far less on purpose.
- [Supabase changelog](https://supabase.com/changelog.md) — new tables aren't exposed automatically (enforced 30 Oct 2026), so explicit grants are required. The September Postgres minor release may require reindexing `btree_gist` (relevant to T10).
- Supabase Postgres best-practice rules — `(select auth.uid())` in policies, indexes on foreign keys, `security definer` only when needed.
- [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security) — signature over the exact URL plus sorted form parameters, HMAC-SHA1 with the auth token.
- [Twilio connection overrides](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides) — 15 s total, 1 retry on connection failure.
- [Twilio webhook request](https://www.twilio.com/docs/messaging/guides/webhook-request) — `MessageSid`, `From`, `To`, `Body`, `ProfileName`, `WaId`. **VERIFY by test:** the page doesn't say what to return when not replying via TwiML; the plan is an empty `<Response/>`.
- [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource) — `POST /2010-04-01/Accounts/{sid}/Messages.json`, form-encoded, Basic auth, `whatsapp:+…` addresses.
- `node_modules/next/dist/docs/.../after.md` — `after()` runs post-response in route handlers, within `maxDuration`.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) and prompt caching — see `CLAUDE.md` → Cost model.
- Still to read after install: `node_modules/ai/docs` for usage fields and test helpers (T06).

## Code inspected

- PaperTrail `supabase/migrations/*` — `model_calls` shape, RLS on, explicit grants.
- PaperTrail `lib/db/client.ts`, `lib/cost/pricing.ts`, `lib/extract/jsonl.ts`, `vitest.config.ts` — client options, dated price table, JSONL append. Reused as patterns.
- `scripts/seed/tenant-fisio-demo.json` — the seed's shape.
- `src/` — untouched scaffold. There is no `.env.example`, and `.gitignore` has `.env*`.

## Decisions and assumptions

**Phase gate.** T02 is still open on your reading of WhatsApp policy section 3. Assumption: that only affects production with a real clinic, so Sandbox work proceeds. If section 3 blocks the use case, the code still stands but the target changes.

**Applying the migration.** This session has no Supabase MCP or CLI. Assumption: you paste the SQL into the lab project's SQL editor, and paste a verification script after it. To let me apply and verify it myself instead, add the MCP to `.mcp.json` and restart.

**Access model.** PaperTrail's "RLS on, no policies" won't do here, because the owner dashboard needs real tenant isolation.
- New table `tenant_members (tenant_id, user_id, role)`, not in the brief's list.
- Every tenant-scoped table gets a read policy for `authenticated`, limited to tenants the user belongs to.
- `authenticated` gets `select` only. `anon` gets nothing. All writes go through server code with the secret key.
- `user_id` has no foreign key to `auth.users`, because the lab project's auth is shared and Agendo stays in its own schema. An orphan row grants nothing.

**Cross-tenant integrity.** Child tables use composite foreign keys, such as `bookings (tenant_id, resource_id) → resources (tenant_id, id)`, so a row can't point across tenants even from server code.

**Phone storage.** Reminders go out when no message is in hand, so the real number must be stored.
- `phone_hash`: HMAC-SHA256 with a pepper. Used for lookups and logs.
- `phone_encrypted`: AES-256-GCM in app code, key from env. A column-level grant keeps it from `authenticated`.
- Rejected: Vault or pgcrypto, which put the key inside the database that holds the ciphertext.

**Consent comes first** (`CLAUDE.md` → Health-sector rules). This replaces "consent line appended to the reply" in T09.
- States: `pending`, `granted`, `declined`, with `consent_at` and `consent_version`.
- Until granted, inbound `content` is stored as NULL. Only metadata and the provider id are kept, since the text may contain health data.
- Only `ACEPTO` grants and `NO` declines, ignoring case, accents and punctuation. A bare "sí" doesn't count.
- Declining deletes `phone_encrypted`.

Draft text, for your edit. It needs a lawyer before a real clinic:

> Hola, soy el asistente de citas de {clínica}. Para ayudarte por este chat tratamos tu nombre, tu número y los datos de tus citas, con el fin de agendarlas y enviarte recordatorios. Como pueden revelar información de salud, son datos sensibles y no estás obligado(a) a autorizar su tratamiento. Se procesan con proveedores en Estados Unidos. Por favor no envíes síntomas, diagnósticos ni documentos. Política: {url}. Responde ACEPTO para continuar o NO para no continuar.

**The privacy page is T25.** Until then `PRIVACY_POLICY_URL` is a placeholder, which is acceptable only because the Sandbox reaches nobody but you.

**Webhook replies asynchronously.** Verify, dedupe, store, return empty TwiML, then send through the REST API inside `after()`. A static reply could use TwiML, but the agent can't fit in 15 s reliably, so we build one path.

**The signature URL comes from env** (`TWILIO_WEBHOOK_URL`), not the request. That removes the proxy, host and protocol trap.

**Per-conversation ordering (T08).** A lease on `conversations`, taken by an atomic update (`processing_until`):
1. Claim the conversation, or stop if someone else holds it; the holder will pick the message up.
2. Process the oldest unprocessed inbound message, repeat until none.
3. Release, re-check for messages that arrived during the release, and re-claim if any.

An expired lease can be taken over after a crash. Rejected: `pg_advisory_lock`, which is tied to a session, and PostgREST's pooled connections don't hold one across requests.

**No Twilio SDK.** Signature checking and one POST are about 30 lines with `node:crypto` and `fetch`. Tests pin the signature against a value computed independently with `openssl`.

**T09 builds the Spanish prompt but sends it nowhere.** No model call should exist before the budget check (T17) and output rules (T23). The phase's exit check is met with static replies.

**No rate limit yet (T16).** Only signed messages from Sandbox-joined numbers arrive, and replies cost no model tokens.

## What this teaches

- **Multi-tenant RLS.** One shared schema with `tenant_id` and policies, instead of one schema per tenant, which would multiply migrations and need the API's exposed-schema list edited for each client. RLS guards the dashboard's session; the secret key bypasses it, so server code still scopes every query.
- **PII handling.** A keyed HMAC instead of plain SHA-256, because Colombian mobile numbers are few enough to hash them all in minutes. Encryption is separate: a hash finds a person, ciphertext lets us message them.
- **Twilio webhooks and the 15-second limit.** Acknowledge first and work after, instead of replying inside the request, where a slow model turns into a Twilio retry and a duplicate.

## Files to touch

**All slices:** `package.json` (exact-pinned deps and scripts), `vitest.config.ts`, `.gitignore` (`!.env.example`), `.env.example`.

**Slice 1:** `supabase/migrations/<timestamp>_foundation.sql` · `supabase/tests/rls_isolation.sql` · `src/lib/db/client.ts` · `scripts/db-smoke.ts` · `scripts/seed.ts`

**Slice 2:** `src/lib/models.ts` · `src/lib/cost/pricing.ts` · `src/lib/calls/record-call.ts` · `src/lib/pii/phone.ts` · `src/lib/pii/redact.ts`, each with tests.

**Slice 3:** `src/lib/channels/whatsapp.ts` · `src/lib/agent/handle-inbound.ts` · `src/lib/db/conversations.ts` · `src/app/api/whatsapp/route.ts`, with tests.

**Slice 4:** `src/lib/agent/consent.ts` · `src/lib/agent/prompt.ts`, with tests · `AGENTS.md` and `CLAUDE.md` (ticks, log, consent wording).

**New dependencies, all exact-pinned, please confirm:** `@supabase/supabase-js` 2.119.0 · `zod` 4.6.7 · `server-only` 0.0.1 · `ai` 7.0.165 · `@ai-sdk/anthropic` 4.0.99 · dev: `vitest` 5.1.0 · `tsx` 4.23.15.

## Requirements

**T03**
1. Create schema `agendo` with these tables: `tenants`, `tenant_members`, `services`, `resources`, `availability_rules`, `availability_exceptions`, `customers`, `bookings`, `conversations`, `messages`, `model_calls`, `tenant_usage`, `reminders`.
2. `bookings.during` is `tstzrange` with `[)` bounds enforced by a check. The exclusion constraint is T10.
3. `messages.provider_message_id` is unique where not null. `model_calls` has the fields in `AGENTS.md` §8.
4. RLS on every table, an index on every foreign key, grants exactly as in "Access model", and no `security definer` functions.
5. Touch nothing outside `agendo`.
6. `supabase/tests/rls_isolation.sql` runs in a transaction that rolls back: inserts two synthetic tenants, switches to `authenticated` with each user's JWT claims, and raises an error if either can read the other's rows, write anything, or read `phone_encrypted`.

**T04**
7. Server-only client scoped to `agendo`.
8. `npm run db:smoke` reads every table and reports a permission or exposure error as an error, never as 0 rows.
9. `npm run seed` upserts the synthetic tenant, validated with Zod, and is safe to re-run.

**T05**
10. `models.ts` holds the only model IDs. The fallback is named as a candidate, since open decision 2 is open.
11. The pricing table carries its read date and handles Haiku's ≤100k and >100k tiers, 5-minute cache writes and reads. An unknown model throws.

**T06**
12. `recordCall` wraps a call and writes one row whatever the outcome, with tokens from the SDK's usage. JSONL when run from a script. Error text is redacted first. Tested with the SDK's mock model; no network.

**T07**
13. Tests cover: the hash is stable and depends on the pepper, encryption round-trips, tampering fails, a missing key throws, and redaction removes phone numbers in common formats.

**T08**
14. A bad or missing signature returns 403 before anything else is read.
15. Payloads are parsed with Zod. A duplicate `MessageSid` is acknowledged and dropped. An unknown receiving number is logged and dropped, with no reply.
16. Logs contain only hashed phones.
17. The ordering lease is implemented as above, and tested with fakes for concurrent arrival, the release race and an expired lease.

**T09**
18. The consent state machine, tested for each state and input, including accents and case.
19. `prompt.ts` builds static instructions first and the tenant block after, with customer text wrapped as data. It states the no-clinical-advice rule. Tests pin the order, and that the static part is byte-identical across tenants.
20. After consent, the reply is a fixed "recibimos tu mensaje" text.

## Security, PII and data safety

- Keys live in `.env.local` only; nothing uses `NEXT_PUBLIC_`. New secrets: `PHONE_HASH_PEPPER`, `PHONE_ENCRYPTION_KEY`, `TWILIO_AUTH_TOKEN`.
- All tenant data is synthetic. The only real number in the system is yours, stored encrypted, with your own consent.
- Text sent before consent is never stored.
- The first real send is to your own Sandbox-joined number, after you message it. Approving this prompt covers that and nothing else.
- Don't paste the Twilio auth token or the secret key into chat.
- Retention (T25) isn't built, so nothing beyond test traffic should enter until it is.

## Cost impact

- Model calls: none, $0.
- Twilio Sandbox: the docs read don't state a price, so VERIFY on your Twilio console. A handful of test messages. Your account's trial credit may cover it.
- Supabase, Vercel: free tier. No deploy in this phase.

## Acceptance criteria

- [ ] Migration applied; only `agendo` changed in the lab project.
- [ ] `rls_isolation.sql` passes.
- [ ] `db:smoke` shows all 13 tables; before schema exposure it shows an error, not 0 rows.
- [ ] Re-running the seed creates no duplicates.
- [ ] A forged signature gets 403 on the running route.
- [ ] Replaying the same `MessageSid` stores one row and sends one reply.
- [ ] First message returns the consent text and stores NULL content.
- [ ] After `ACEPTO`, a message is stored and gets a reply. **(Phase exit check)**
- [ ] No plaintext phone in logs or `model_calls`.
- [ ] `npm test` makes no network calls.

## Checks

- `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` (routes and server modules change)
- `npm run db:smoke` (free, reads the lab project)

## Manual test steps

**After slice 1**
1. Paste the migration into the lab project's SQL editor and run it.
2. Run `supabase/tests/rls_isolation.sql` the same way.
3. Add `agendo` to Settings → API → Exposed schemas, keeping `papertrail` in the list.
4. Run `npm run db:smoke`, then `npm run seed`.

**After slice 3**
5. In Twilio Console → Messaging → Try it out, join the Sandbox from your phone.
6. Install a tunnel, for example `brew install cloudflared`, then run `npm run dev` and `cloudflared tunnel --url http://localhost:3000`.
7. Set `TWILIO_WEBHOOK_URL` in `.env.local` to `https://<tunnel>/api/whatsapp`, restart dev, and put the same URL in Sandbox settings → "When a message comes in".
8. Send a forged POST with `curl` and confirm 403.

**After slice 4, the exit check**
9. From your phone, send "hola". You should receive the consent text.
10. Check `agendo.messages`: the row has NULL content.
11. Reply `ACEPTO`, then send "quiero una cita".
12. You should get the fixed reply, and the row should contain your text.
13. If the Sandbox stops responding, your 3-day membership may have expired. Rejoin.

## Results

Filled in after the work.
