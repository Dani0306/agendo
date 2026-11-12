// One scripted booking conversation through the real core and the real model: a
// question, then book, reschedule and cancel, each checked against the database row.
// Shared by agent-smoke (one run) and cache-ab (two runs). Synthetic visitor, removed
// at the end; its model_calls rows stay as the record of what it cost.
import { randomUUID } from "node:crypto";
import type { AgentDeps } from "@/lib/agent/loop";
import { handleInline } from "@/lib/agent/handle-inbound";
import type { Reply } from "@/lib/agent/reply";
import { demoConfig, inboundDeps, WEB_DEADLINE_MS } from "@/lib/agent/runtime";
import { db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";
import { hashWebVisitor, loadPiiSecrets } from "@/lib/pii/phone";

const CONFIRM = "Sí, confirmo, por favor hazlo.";

export type CallRow = {
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  outcome: string;
};

export type ConversationResult = { ok: boolean; error?: string; calls: CallRow[]; transcript: { said: string; reply: string; tools: string[] }[] };

export async function runScriptedConversation(options: {
  promptCache: AgentDeps["promptCache"];
  maxUsd: number;
  quiet?: boolean;
}): Promise<ConversationResult> {
  const demo = demoConfig();
  if (!demo) throw new Error("Set DEMO_CHAT_ENABLED=1 and DEMO_RECEIVING_NUMBER");

  const client = db();
  // No response cache: every turn must reach the model, or the arms aren't comparable.
  const deps = inboundDeps(WEB_DEADLINE_MS, { promptCache: options.promptCache, responseCache: false });
  const visitor = `scripted-${randomUUID()}`;
  const phoneHash = hashWebVisitor(visitor, loadPiiSecrets().pepper);
  const tenant = unwrap(await client.from("tenants").select("id").eq("receiving_number", demo.receivingNumber).single()) as {
    id: string;
  };

  let conversationId: string | null = null;
  let customerId: string | null = null;
  const transcript: ConversationResult["transcript"] = [];

  const calls = async (): Promise<CallRow[]> =>
    conversationId
      ? (unwrap(
          await client
            .from("model_calls")
            .select("input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_usd, latency_ms, outcome")
            .eq("conversation_id", conversationId)
            .order("id"),
        ) as CallRow[])
      : [];
  const spent = async () => (await calls()).reduce((sum, call) => sum + Number(call.cost_usd), 0);

  const say = async (text: string): Promise<Reply> => {
    if ((await spent()) > options.maxUsd) throw new Error(`Stopped at the $${options.maxUsd} cap`);
    const replies = await handleInline(deps, { channel: "web", providerMessageId: `web:${randomUUID()}`, from: visitor, to: demo.receivingNumber, body: text });
    const reply = replies[0];
    if (!reply) throw new Error("No reply");
    const tools = reply.trace.tools.map((tool) => `${tool.name}:${tool.status}`);
    transcript.push({ said: text, reply: reply.text, tools });
    if (!options.quiet) console.log(`\n> ${text}\n${reply.text}\n  [${tools.join(", ") || "no tools"}]`);

    if (!customerId) {
      const customer = unwrap(await client.from("customers").select("id").eq("tenant_id", tenant.id).eq("phone_hash", phoneHash).single()) as { id: string };
      customerId = customer.id;
      const conversation = unwrap(await client.from("conversations").select("id").eq("tenant_id", tenant.id).eq("customer_id", customerId).single()) as { id: string };
      conversationId = conversation.id;
    }
    return reply;
  };

  /** The model may ask for confirmation first, which is allowed. */
  const until = async (status: string, text: string) => {
    for (const message of [text, CONFIRM, CONFIRM]) {
      const reply = await say(message);
      if (reply.trace.tools.some((tool) => tool.status === status)) return;
    }
    throw new Error(`Never reached ${status}`);
  };

  const rows = async () =>
    unwrap(await client.from("bookings").select("status, during").eq("tenant_id", tenant.id).eq("customer_id", customerId!)) as {
      status: string;
      during: string;
    }[];

  try {
    await say("hola");
    await say("ACEPTO");
    await say("¿Cuánto cuesta la valoración inicial y dónde están ubicados?");
    await until("booked", "Quiero agendar una valoración inicial el próximo martes a las 10 de la mañana.");
    await until("rescheduled", "Por favor cambia mi cita para ese mismo día a las 3 de la tarde.");
    await until("cancelled", "Mejor cancela esa cita, por favor.");

    const final = await rows();
    if (final.length !== 1 || final[0]!.status !== "cancelled") throw new Error("Expected one cancelled row");
    return { ok: true, calls: await calls(), transcript };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), calls: await calls(), transcript };
  } finally {
    if (customerId) unwrap(await client.from("customers").delete().eq("tenant_id", tenant.id).eq("id", customerId).select("id"));
  }
}
