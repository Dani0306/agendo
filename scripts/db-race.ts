// Fires parallel inserts for one slot against the real database. Needs the network,
// so it is not part of `npm test`. Synthetic rows, removed at the end.
import { db } from "@/lib/db/client";
import { unwrap } from "@/lib/db/unwrap";

const ATTEMPTS = 10;
// Per run, so an earlier run that failed before its cleanup can't block this one.
const RACE_NUMBER = `whatsapp:+1999${String(Date.now()).slice(-8)}`;

async function main() {
  const client = db();
  const tenant = unwrap(
    await client
      .from("tenants")
      .insert({ name: "Race test", business_type: "test", timezone: "UTC", receiving_number: RACE_NUMBER })
      .select("id")
      .single(),
  ) as { id: string };

  try {
    const tenantId = tenant.id;
    const single = async (table: string, row: Record<string, unknown>) =>
      unwrap(await client.from(table).insert({ tenant_id: tenantId, ...row }).select("id").single()) as { id: string };

    const service = await single("services", { name: "Race", duration_minutes: 60, price: 1 });
    const resource = await single("resources", { name: "Race", kind: "test" });
    const customer = await single("customers", { phone_hash: "race-test" });

    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        client.from("bookings").insert({
          tenant_id: tenantId,
          resource_id: resource.id,
          service_id: service.id,
          customer_id: customer.id,
          during: "[2030-01-07 15:00+00,2030-01-07 16:00+00)",
        }),
      ),
    );

    const accepted = results.filter((result) => result.error === null).length;
    const rejected = results.filter((result) => result.error?.code === "23P01").length;
    console.log(`${ATTEMPTS} parallel inserts: ${accepted} accepted, ${rejected} rejected with 23P01`);
    if (accepted !== 1 || rejected !== ATTEMPTS - 1) process.exitCode = 1;
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
