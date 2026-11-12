// Runs overlapping reminder claims against the real database and checks that no
// reminder comes back twice. Needs the network, so it is not part of `npm test`.
// Synthetic rows, removed at the end. It refuses to run while any real reminder is
// due, because a claim here would take it without sending it.
import { db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";

const BOOKINGS = 6;
const CLAIMERS = 4;
const LEAD = "24 hours";

async function main() {
  const client = db();
  const now = Date.now();
  const dueReal = unwrap(
    await client
      .from("bookings")
      .select("id")
      .eq("status", "confirmed")
      .overlaps("during", `[${new Date(now).toISOString()},${new Date(now + 86_400_000).toISOString()})`),
  ) as unknown[];
  if (dueReal.length > 0) throw new Error(`${dueReal.length} real bookings are inside the reminder window; not running`);

  const number = `whatsapp:+1998${String(now).slice(-8)}`;
  const tenant = unwrap(
    await client.from("tenants").insert({ name: "Reminder race", business_type: "test", timezone: "UTC", receiving_number: number }).select("id").single(),
  ) as { id: string };

  try {
    const insert = async (table: string, row: Record<string, unknown>) =>
      unwrap(await client.from(table).insert({ tenant_id: tenant.id, ...row }).select("id").single()) as { id: string };
    const service = await insert("services", { name: "Race", duration_minutes: 60, price: 1 });
    const resource = await insert("resources", { name: "Race", kind: "test" });
    const customer = await insert("customers", {
      phone_hash: "reminder-race",
      phone_encrypted: "v1:x:y:z",
      consent_status: "granted",
      consent_at: new Date(now).toISOString(),
      consent_version: "test",
    });
    await insert("conversations", { customer_id: customer.id, channel: "whatsapp" });

    const hour = 3_600_000;
    const start = Math.ceil(now / hour) * hour;
    for (let index = 0; index < BOOKINGS; index += 1) {
      const from = new Date(start + (index + 2) * hour).toISOString();
      const to = new Date(start + (index + 3) * hour).toISOString();
      await insert("bookings", { resource_id: resource.id, service_id: service.id, customer_id: customer.id, during: `[${from},${to})` });
    }

    const runs = await Promise.all(
      Array.from({ length: CLAIMERS }, () => client.rpc("claim_due_reminders", { p_lead: LEAD, p_limit: 10 })),
    );
    const ids = runs.flatMap((run) => (unwrap(run) as { reminder_id: string }[]).map((row) => row.reminder_id));
    const unique = new Set(ids).size;
    console.log(`${CLAIMERS} overlapping claims over ${BOOKINGS} due bookings: ${ids.length} returned, ${unique} distinct`);
    if (ids.length !== BOOKINGS || unique !== BOOKINGS) process.exitCode = 1;
  } finally {
    // Bookings first: their foreign keys to services and resources don't cascade.
    unwrap(await client.from("bookings").delete().eq("tenant_id", tenant.id).select("id"));
    unwrap(await client.from("tenants").delete().eq("id", tenant.id).select("id"));
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
