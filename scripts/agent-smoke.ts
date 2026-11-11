// One scripted conversation through the real core and the real model: book, reschedule,
// cancel. Costs money, so it stops at a cap and is not part of `npm test`. Synthetic
// visitor, removed at the end. Its model_calls rows stay, as the record of what it cost.
import { randomUUID } from "node:crypto";
import { handleInline } from "@/lib/agent/handle-inbound";
import type { Reply } from "@/lib/agent/reply";
import { demoConfig, inboundDeps, WEB_DEADLINE_MS } from "@/lib/agent/runtime";
import { db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";
import { hashWebVisitor, loadPiiSecrets } from "@/lib/pii/phone";

const MAX_USD = 0.05;
const CONFIRM = "Sí, confirmo, por favor hazlo.";

type CallRow = {
  cost_usd: number;
  latency_ms: number;
  outcome: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
};

async function main() {
  const demo = demoConfig();
  if (!demo) throw new Error("Set DEMO_CHAT_ENABLED=1 and DEMO_RECEIVING_NUMBER");

  const client = db();
  const deps = inboundDeps(WEB_DEADLINE_MS);
  const visitor = `smoke-${randomUUID()}`;
  const phoneHash = hashWebVisitor(visitor, loadPiiSecrets().pepper);
  const tenant = unwrap(
    await client.from("tenants").select("id").eq("receiving_number", demo.receivingNumber).single(),
  ) as { id: string };

  let conversationId: string | null = null;
  let customerId: string | null = null;

  const spent = async () => {
    if (!conversationId) return { usd: 0, calls: [] as CallRow[] };
    const calls = unwrap(
      await client
        .from("model_calls")
        .select("cost_usd, latency_ms, outcome, input_tokens, cache_read_tokens, output_tokens")
        .eq("conversation_id", conversationId),
    ) as CallRow[];
    return { usd: calls.reduce((sum, call) => sum + Number(call.cost_usd), 0), calls };
  };

  const say = async (text: string): Promise<Reply> => {
    if ((await spent()).usd > MAX_USD) throw new Error(`Stopped at the $${MAX_USD} cap`);
    const replies = await handleInline(deps, {
      channel: "web",
      providerMessageId: `web:${randomUUID()}`,
      from: visitor,
      to: demo.receivingNumber,
      body: text,
    });
    const reply = replies[0];
    if (!reply) throw new Error("No reply");
    const tools = reply.trace.tools.map((tool) => `${tool.name}:${tool.status}`).join(", ") || "no tools";
    console.log(`\n> ${text}\n${reply.text}\n  [${tools}]`);

    if (!customerId) {
      const customer = unwrap(
        await client.from("customers").select("id").eq("tenant_id", tenant.id).eq("phone_hash", phoneHash).single(),
      ) as { id: string };
      customerId = customer.id;
      const conversation = unwrap(
        await client.from("conversations").select("id").eq("tenant_id", tenant.id).eq("customer_id", customerId).single(),
      ) as { id: string };
      conversationId = conversation.id;
    }
    return reply;
  };

  /** The model may ask for confirmation first, which is allowed. */
  const until = async (status: string, text: string) => {
    for (const message of [text, CONFIRM, CONFIRM]) {
      const reply = await say(message);
      if (reply.trace.tools.some((tool) => tool.status === status)) return reply;
    }
    throw new Error(`Never reached ${status}`);
  };

  const rows = async () =>
    unwrap(
      await client.from("bookings").select("status, during").eq("tenant_id", tenant.id).eq("customer_id", customerId!),
    ) as { status: string; during: string }[];

  let failed = false;
  try {
    await say("hola");
    await say("ACEPTO");
    await say("¿Cuánto cuesta la valoración inicial y dónde están ubicados?");

    await until("booked", "Quiero agendar una valoración inicial el próximo martes a las 10 de la mañana.");
    console.log("  row:", JSON.stringify(await rows()));
    await until("rescheduled", "Por favor cambia mi cita para ese mismo día a las 3 de la tarde.");
    console.log("  row:", JSON.stringify(await rows()));
    await until("cancelled", "Mejor cancela esa cita, por favor.");

    const final = await rows();
    console.log("  row:", JSON.stringify(final));
    if (final.length !== 1 || final[0]!.status !== "cancelled") throw new Error("Expected one cancelled row");
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    const { usd, calls } = await spent();
    const latencies = calls.map((call) => call.latency_ms).sort((a, b) => a - b);
    const total = (field: "input_tokens" | "cache_read_tokens" | "output_tokens") =>
      calls.reduce((sum, call) => sum + call[field], 0);
    console.log(
      `\n${calls.length} model calls, $${usd.toFixed(6)}, outcomes ${[...new Set(calls.map((call) => call.outcome))].join("/")}, ` +
        `median latency ${latencies[Math.floor(latencies.length / 2)] ?? 0} ms, max ${latencies.at(-1) ?? 0} ms, ` +
        `input ${total("input_tokens")}, cached ${total("cache_read_tokens")}, output ${total("output_tokens")}`,
    );
    if (customerId) {
      unwrap(await client.from("customers").delete().eq("tenant_id", tenant.id).eq("id", customerId).select("id"));
    }
  }
  if (failed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
