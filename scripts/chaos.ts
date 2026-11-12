// The chaos test (T22). Breaks the model path on purpose, against the real core and the
// real OpenAI API, and checks the customer still gets a useful reply every time.
//
//   A  Revoked key mid-conversation: two answers on the real key, then a key OpenAI
//      rejects (a real 401) for the rest. Expect the menu, a menu answer, and, once the
//      breakers open, turns that don't call the dead models at all.
//   B  Primary model gone: the primary points at a model that doesn't exist (a real 404).
//      Expect the whole booking conversation to run on the fallback. Its cost closes
//      open decision 2.
//   C  Recovery: A's conversation with the real key back. After the breakers' cool-down
//      a probe succeeds and the primary serves again.
//
// Writes evals/runs/<date>-chaos.json. Costs money: about $0.03, stopped at $0.10.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createOpenAI } from "@ai-sdk/openai";
import { handleInline } from "@/lib/agent/handle-inbound";
import type { Reply } from "@/lib/agent/reply";
import { demoConfig, inboundDeps, WEB_DEADLINE_MS } from "@/lib/agent/runtime";
import { PRICES, PRICING_READ_ON } from "@/lib/cost/pricing";
import { db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";
import { FALLBACK_MODEL, PRIMARY_MODEL } from "@/lib/models";
import { hashWebVisitor, loadPiiSecrets } from "@/lib/pii/phone";
import { BREAKER, memoryBreakerStore } from "@/lib/resilience/breaker";
import type { ChainModel } from "@/lib/resilience/chain";
import { runScriptedConversation } from "./lib/scripted-conversation";

const MAX_USD = 0.1;
/** Not a real key. OpenAI answers it with 401, exactly as it would a revoked one. */
const REVOKED_KEY = "sk-agendo-chaos-revoked-key-not-real";
const MISSING_MODEL = "agendo-chaos-no-such-model";

type Turn = {
  said: string;
  phase: string;
  degraded: string | null;
  served_by: string | null;
  tools: string[];
  model_calls: number;
  failed_calls: number;
  latency_ms: number;
  useful: boolean;
};

/** A reply a customer can act on. "A person will write soon", or nothing, is not. */
function isUseful(reply: Reply | undefined): boolean {
  return reply !== undefined && reply.degraded !== "person_soon" && reply.text.trim().length > 0;
}

function chainWith(provider: ReturnType<typeof createOpenAI>): ChainModel[] {
  return [
    { id: PRIMARY_MODEL, model: provider(PRIMARY_MODEL) },
    { id: FALLBACK_MODEL, model: provider(FALLBACK_MODEL) },
  ];
}

async function main() {
  const demo = demoConfig();
  if (!demo) throw new Error("Set DEMO_CHAT_ENABLED=1 and DEMO_RECEIVING_NUMBER");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const client = db();
  const tenant = unwrap(await client.from("tenants").select("id").eq("receiving_number", demo.receivingNumber).single()) as {
    id: string;
  };
  const startedAt = new Date().toISOString();

  // ── A and C: one conversation, the key revoked and then restored ──────────────────
  const breakers = memoryBreakerStore(Date.now); // isolated: this run can't trip the shared breaker
  const healthy = inboundDeps(WEB_DEADLINE_MS, { responseCache: false, breakerStore: breakers, chain: chainWith(createOpenAI({ apiKey })) });
  const revoked = inboundDeps(WEB_DEADLINE_MS, {
    responseCache: false,
    breakerStore: breakers,
    chain: chainWith(createOpenAI({ apiKey: REVOKED_KEY })),
  });

  const visitor = `chaos-${randomUUID()}`;
  const phoneHash = hashWebVisitor(visitor, loadPiiSecrets().pepper);
  let conversationId: string | null = null;
  let customerId: string | null = null;
  const turns: Turn[] = [];

  const calls = async () =>
    conversationId
      ? (unwrap(await client.from("model_calls").select("model, outcome, cost_usd").eq("conversation_id", conversationId).order("id")) as {
          model: string;
          outcome: string;
          cost_usd: number;
        }[])
      : [];

  const say = async (deps: typeof healthy, phase: string, text: string) => {
    const before = (await calls()).length;
    const started = Date.now();
    const replies = await handleInline(deps, { channel: "web", providerMessageId: `web:${randomUUID()}`, from: visitor, to: demo.receivingNumber, body: text });
    const latency = Date.now() - started;
    const reply = replies[0];

    if (!customerId) {
      customerId = (unwrap(await client.from("customers").select("id").eq("tenant_id", tenant.id).eq("phone_hash", phoneHash).single()) as { id: string }).id;
      conversationId = (
        unwrap(await client.from("conversations").select("id").eq("tenant_id", tenant.id).eq("customer_id", customerId).single()) as { id: string }
      ).id;
    }
    const made = (await calls()).slice(before);
    const turn: Turn = {
      said: text,
      phase,
      degraded: reply?.degraded ?? null,
      served_by: reply?.trace.model ?? null,
      tools: reply?.trace.tools.map((tool) => `${tool.name}:${tool.status}`) ?? [],
      model_calls: made.length,
      failed_calls: made.filter((call) => call.outcome !== "ok").length,
      latency_ms: latency,
      useful: isUseful(reply),
    };
    turns.push(turn);
    console.log(
      `[${phase}] ${text.padEnd(58).slice(0, 58)} → ${turn.degraded ?? "answer"}${turn.served_by ? ` (${turn.served_by})` : ""}, ` +
        `${turn.model_calls} calls (${turn.failed_calls} failed), ${latency} ms`,
    );
    return turn;
  };

  let scenarioB: Awaited<ReturnType<typeof runScriptedConversation>> | null = null;
  let costAandC = 0;
  try {
    // Consent first: static replies, not part of the measurement.
    await say(healthy, "consent", "hola");
    await say(healthy, "consent", "ACEPTO");

    await say(healthy, "A: real key", "¿Cuánto cuesta la valoración inicial?");
    await say(healthy, "A: real key", "¿Atienden los sábados?");

    // The key is revoked from here on.
    await say(revoked, "A: revoked", "Quiero agendar una valoración el próximo martes a las 10 de la mañana.");
    await say(revoked, "A: revoked", "¿Dónde están ubicados?");
    await say(revoked, "A: revoked", "¿Tienen parqueadero?");
    await say(revoked, "A: revoked", "2");
    await say(revoked, "A: revoked", "¿Y atienden por EPS?");

    // The key is back. Wait out the breakers' cool-down, then the probe should succeed.
    console.log(`Waiting ${BREAKER.cooldownMs / 1000} s for the breakers' cool-down…`);
    await new Promise((resolve) => setTimeout(resolve, BREAKER.cooldownMs + 1_000));
    await say(healthy, "C: restored", "¿Cuánto cuesta una sesión de fisioterapia?");
    await say(healthy, "C: restored", "Gracias, ¿y dónde están ubicados?");

    // ── B: the primary model doesn't exist; the fallback carries a full booking ────────
    const spentSoFar = (await calls()).reduce((sum, call) => sum + Number(call.cost_usd), 0);
    if (spentSoFar > MAX_USD) throw new Error(`Stopped at the $${MAX_USD} cap`);
    console.log("Scenario B: primary model missing, full booking conversation on the fallback");
    const provider = createOpenAI({ apiKey });
    scenarioB = await runScriptedConversation({
      promptCache: "implicit",
      maxUsd: MAX_USD - spentSoFar,
      quiet: true,
      inbound: {
        breakerStore: memoryBreakerStore(Date.now),
        chain: [
          { id: "chaos-missing-model", model: provider(MISSING_MODEL), priceModel: PRIMARY_MODEL },
          { id: FALLBACK_MODEL, model: provider(FALLBACK_MODEL) },
        ],
      },
    });
  } finally {
    // Before the cleanup: deleting the visitor detaches its model_calls rows from the conversation.
    costAandC = (await calls()).reduce((sum, call) => sum + Number(call.cost_usd), 0);
    if (customerId) unwrap(await client.from("customers").delete().eq("tenant_id", tenant.id).eq("id", customerId).select("id"));
  }

  // ── Results ─────────────────────────────────────────────────────────────────────────
  const measured = turns.filter((turn) => turn.phase !== "consent");
  const byPhase = (prefix: string) => measured.filter((turn) => turn.phase.startsWith(prefix));
  const availability = (list: Turn[]) => (list.length === 0 ? 0 : list.filter((turn) => turn.useful).length / list.length);

  const revokedTurns = byPhase("A: revoked");
  const lastRevoked = revokedTurns.at(-1);
  const restored = byPhase("C");

  const bCalls = scenarioB?.calls ?? [];
  const bServed = bCalls.filter((call) => call.outcome === "ok");
  const bFallbackCost = bCalls.filter((call) => call.model === FALLBACK_MODEL).reduce((sum, call) => sum + Number(call.cost_usd), 0);
  const bTranscript = scenarioB?.transcript ?? [];

  const checks = {
    a_every_turn_useful: availability(byPhase("A")) === 1,
    a_breakers_skip_dead_models: lastRevoked !== undefined && lastRevoked.model_calls === 0,
    a_menu_answered_without_model: revokedTurns.some((turn) => turn.said === "2" && turn.model_calls === 0 && turn.useful),
    b_booking_completed_on_fallback: scenarioB?.ok === true && bServed.length > 0 && bServed.every((call) => call.model === FALLBACK_MODEL),
    c_primary_serves_again: restored.length > 0 && restored.every((turn) => turn.served_by === PRIMARY_MODEL && turn.degraded === null),
  };
  const passed = Object.values(checks).every(Boolean);

  const run = {
    kind: "chaos",
    started_at: startedAt,
    models: { primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL },
    prices_read_on: PRICING_READ_ON,
    prices_per_million_usd: { [PRIMARY_MODEL]: PRICES[PRIMARY_MODEL], [FALLBACK_MODEL]: PRICES[FALLBACK_MODEL] },
    breaker: BREAKER,
    passed,
    checks,
    availability_under_failure: {
      a_revoked_key: availability(byPhase("A")),
      b_primary_missing: bTranscript.length === 0 ? 0 : 1,
      c_recovery: availability(restored),
      all_measured_turns: availability(measured),
    },
    scenario_a_and_c: { turns },
    scenario_b: {
      ok: scenarioB?.ok ?? false,
      error: scenarioB?.error ?? null,
      model_calls: bCalls.length,
      failed_calls_on_missing_model: bCalls.filter((call) => call.model === "chaos-missing-model").length,
      fallback_calls: bServed.length,
      fallback_cost_per_conversation_usd: Number(bFallbackCost.toFixed(8)),
      transcript: bTranscript,
    },
    cost_usd: {
      a_and_c: Number(costAandC.toFixed(8)),
      b: Number(bCalls.reduce((sum, call) => sum + Number(call.cost_usd), 0).toFixed(8)),
      total: Number((costAandC + bCalls.reduce((sum, call) => sum + Number(call.cost_usd), 0)).toFixed(8)),
    },
  };

  await mkdir("evals/runs", { recursive: true });
  const path = `evals/runs/${startedAt.slice(0, 10)}-chaos.json`;
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ passed, checks, availability: run.availability_under_failure, fallback_cost: run.scenario_b.fallback_cost_per_conversation_usd }, null, 2));
  console.log(`Wrote ${path}`);
  if (!passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
