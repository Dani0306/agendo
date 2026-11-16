// Runs one scenario through the real core: its own seeded clinic, the scenario's clock
// injected, a simulated customer driving the conversation, and every row read back from
// the database for scoring.
import { randomUUID } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import { handleInline } from "@/lib/agent/handle-inbound";
import { inboundDeps, WEB_DEADLINE_MS } from "@/lib/agent/runtime";
import { utcToLocal } from "@/lib/booking/timezone";
import { dbSink } from "@/lib/calls/sinks";
import { db } from "@/lib/db/client";
import { parseRange } from "@/lib/db/bookings";
import { unwrap } from "@/lib/db/unwrap";
import { PRIMARY_MODEL } from "@/lib/models";
import { hashWebVisitor, loadPiiSecrets } from "@/lib/pii/phone";
import { memoryBreakerStore } from "@/lib/resilience/breaker";
import type { Scenario } from "./schema";
import type { BookingRow, CallRow, ScenarioRecord, TranscriptTurn } from "./scorer";
import { dropEvalTenant, placeBooking, seedEvalTenant } from "./seed";
import { DONE, nextCustomerMessage } from "./simulated-customer";

/** Three tries a second apart: a network blip mustn't leave a seeded clinic behind. */
async function persistently<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
}

function describeNow(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(now).replace(/ /g, " ");
}

export async function runScenario(scenario: Scenario): Promise<ScenarioRecord> {
  const client = db();
  const tenant = await seedEvalTenant(client);
  const transcript: TranscriptTurn[] = [];
  let bookings: BookingRow[] = [];
  let calls: CallRow[] = [];
  let error: string | null = null;

  try {
    // The scenario's moment, moving forward in real time from there.
    const clockStart = Date.parse(scenario.clock);
    const realStart = Date.now();
    const now = () => new Date(clockStart + (Date.now() - realStart));

    const deps = inboundDeps(WEB_DEADLINE_MS, { now, responseCache: false, breakerStore: memoryBreakerStore(Date.now) });
    const visitor = `eval-${scenario.id}-${randomUUID()}`;
    const say = (body: string) =>
      handleInline(deps, { channel: "web", providerMessageId: `web:${randomUUID()}`, from: visitor, to: tenant.receivingNumber, body });

    // Consent first; not part of what's scored.
    await say("hola");
    await say("ACEPTO");

    const phoneHash = hashWebVisitor(visitor, loadPiiSecrets().pepper);
    const customer = unwrap(await client.from("customers").select("id").eq("tenant_id", tenant.id).eq("phone_hash", phoneHash).single()) as {
      id: string;
    };
    const conversation = unwrap(
      await client.from("conversations").select("id").eq("tenant_id", tenant.id).eq("customer_id", customer.id).single(),
    ) as { id: string };

    // Bookings that exist before the customer writes.
    const setupIds = new Set<string>();
    let other: string | null = null;
    for (const booking of scenario.setup.bookings) {
      let customerId = customer.id;
      if (!booking.mine) {
        other ??= (
          unwrap(await client.from("customers").insert({ tenant_id: tenant.id, phone_hash: `eval-other-${randomUUID()}` }).select("id").single()) as {
            id: string;
          }
        ).id;
        customerId = other;
      }
      setupIds.add(await placeBooking(client, tenant, { ...booking, customerId }));
    }

    const simulated = {
      model: openai(PRIMARY_MODEL),
      modelId: PRIMARY_MODEL,
      record: { sink: dbSink(client) },
      tenantId: tenant.id,
      conversationId: conversation.id,
    };

    let message = scenario.opening;
    for (let turn = 0; turn < scenario.max_turns; turn += 1) {
      transcript.push({ role: "customer", text: message });
      const replies = await say(message);
      for (const reply of replies) {
        transcript.push({
          role: "agent",
          text: reply.text,
          degraded: reply.degraded ?? null,
          tools: reply.trace.tools.map((tool) => `${tool.name}:${tool.status}`),
        });
      }
      if (turn + 1 >= scenario.max_turns) break;
      const next = await nextCustomerMessage(simulated, scenario, transcript, describeNow(now(), tenant.timezone));
      if (next === DONE) break;
      message = next;
    }

    type Row = {
      id: string;
      status: BookingRow["status"];
      during: string;
      customer_id: string;
      resource_id: string;
      services: { name: string };
      resources: { name: string };
    };
    const rows = unwrap(
      await client.from("bookings").select("id, status, during, customer_id, resource_id, services(name), resources(name)").eq("tenant_id", tenant.id),
    ) as unknown as Row[];
    bookings = rows.map((row) => {
      const { start, end } = parseRange(row.during);
      const local = utcToLocal(start, tenant.timezone);
      return {
        status: row.status,
        service: row.services.name,
        professional: row.resources.name,
        resourceId: row.resource_id,
        date: local.date,
        time: local.time,
        start: start.toISOString(),
        end: end.toISOString(),
        mine: row.customer_id === customer.id,
        setup: setupIds.has(row.id),
      };
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 300) : String(caught);
  } finally {
    // Before the cleanup: deleting the clinic deletes its model_calls rows.
    try {
      calls = (
        (await persistently(async () =>
          unwrap(
            await client
              .from("model_calls")
              .select("purpose, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_usd, outcome")
              .eq("tenant_id", tenant.id),
          ),
        )) as CallRow[]
      ).map((row) => ({ ...row, cost_usd: Number(row.cost_usd) }));
    } catch (caught) {
      error ??= `could not read model_calls: ${caught instanceof Error ? caught.message.slice(0, 200) : String(caught)}`;
    }
    try {
      await persistently(() => dropEvalTenant(client, tenant.id));
    } catch {
      // Left behind; `npm run eval:cleanup` removes it.
      console.error(`Eval clinic ${tenant.id} was not removed; run npm run eval:cleanup.`);
    }
  }

  return { scenario, transcript, bookings, calls, prices: tenant.prices, error };
}
