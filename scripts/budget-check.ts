// Two live checks of the budget against the real database. Free: neither reaches a model.
//   1. Parallel reservations can't spend past the limit.
//   2. A tenant whose budget is $0 gets the static reply and no model_calls row.
// Synthetic tenants, removed at the end.
import { randomUUID } from "node:crypto";
import { handleInline } from "@/lib/agent/handle-inbound";
import { inboundDeps, WEB_DEADLINE_MS } from "@/lib/agent/runtime";
import { postgresBudget } from "@/lib/db/budget";
import { db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";

const PARALLEL = 10;

async function main() {
  const client = db();
  const suffix = String(Date.now()).slice(-8);
  const created: string[] = [];

  const tenant = async (name: string, number: string, budget: number) => {
    const row = unwrap(
      await client
        .from("tenants")
        .insert({ name, business_type: "test", timezone: "America/Bogota", receiving_number: number, monthly_budget_usd: budget })
        .select("id")
        .single(),
    ) as { id: string };
    created.push(row.id);
    return row.id;
  };

  let failed = false;
  try {
    // 1. Ten reservations of $0.30 against $1.00: exactly three fit.
    const capped = await tenant("Budget race", `whatsapp:+1997${suffix}`, 1);
    const budget = postgresBudget(client);
    const results = await Promise.all(Array.from({ length: PARALLEL }, () => budget.reserve(capped, 0.3)));
    const passed = results.filter((reservation) => reservation !== null).length;
    const usage = unwrap(await client.from("tenant_usage").select("reserved_usd").eq("tenant_id", capped).single()) as {
      reserved_usd: number;
    };
    console.log(`${PARALLEL} parallel $0.30 reservations against $1.00: ${passed} passed, $${Number(usage.reserved_usd).toFixed(2)} held`);
    if (passed !== 3 || Number(usage.reserved_usd) !== 0.9) failed = true;

    // 2. A $0 tenant, end to end through the real core.
    const number = `whatsapp:+1996${suffix}`;
    const blocked = await tenant("Budget zero", number, 0);
    const deps = inboundDeps(WEB_DEADLINE_MS);
    const visitor = `budget-${randomUUID()}`;
    const say = async (body: string) =>
      (await handleInline(deps, { channel: "web", providerMessageId: `web:${randomUUID()}`, from: visitor, to: number, body }))[0];

    await say("hola");
    await say("ACEPTO");
    const reply = await say("Quiero agendar una valoración el martes");
    const calls = unwrap(await client.from("model_calls").select("id").eq("tenant_id", blocked)) as unknown[];
    console.log(`$0 tenant: reply "${reply?.degraded ?? "none"}", ${calls.length} model calls`);
    if (reply?.degraded !== "over_budget" || calls.length !== 0) failed = true;
  } finally {
    for (const id of created) unwrap(await client.from("tenants").delete().eq("id", id).select("id"));
  }
  if (failed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
