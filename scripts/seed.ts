// Upserts the synthetic tenant. Safe to re-run. Touches only that tenant's rows.
import { readFileSync } from "node:fs";
import { db } from "@/lib/db/client";
import { TenantSeedSchema, WEEKDAY_NUMBERS } from "@/lib/db/seed-schema";
import { unwrap } from "@/lib/db/unwrap";

const SEED_FILE = new URL("./seed/tenant-fisio-demo.json", import.meta.url);

async function main() {
  const seed = TenantSeedSchema.parse(JSON.parse(readFileSync(SEED_FILE, "utf8")));
  const client = db();

  const tenant = unwrap(
    await client
      .from("tenants")
      .upsert({ ...seed.tenant, faq: seed.faq }, { onConflict: "receiving_number" })
      .select("id")
      .single(),
  ) as { id: string };
  const tenantId = tenant.id;

  unwrap(
    await client
      .from("services")
      .upsert(seed.services.map((service) => ({ ...service, tenant_id: tenantId })), { onConflict: "tenant_id,name" })
      .select("id"),
  );

  const resources = unwrap(
    await client
      .from("resources")
      .upsert(seed.resources.map((resource) => ({ ...resource, tenant_id: tenantId })), { onConflict: "tenant_id,name" })
      .select("id"),
  ) as { id: string }[];

  // Nothing references these two tables, so replacing their rows is the simplest upsert.
  unwrap(await client.from("availability_rules").delete().eq("tenant_id", tenantId).select("id"));
  unwrap(await client.from("availability_exceptions").delete().eq("tenant_id", tenantId).select("id"));

  const rules = resources.flatMap((resource) =>
    seed.availability_rules.weekly.map((row) => ({
      tenant_id: tenantId,
      resource_id: resource.id,
      weekday: WEEKDAY_NUMBERS[row.weekday],
      opens: row.opens,
      closes: row.closes,
    })),
  );
  unwrap(await client.from("availability_rules").insert(rules).select("id"));

  const closures = seed.availability_rules.closed_dates.map((closedDate) => ({
    tenant_id: tenantId,
    resource_id: null,
    closed_date: closedDate,
  }));
  unwrap(await client.from("availability_exceptions").insert(closures).select("id"));

  console.log(
    `Seeded "${seed.tenant.name}": ${seed.services.length} services, ${resources.length} resources, ${rules.length} hours rows, ${closures.length} closed dates.`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
