// A fresh copy of the synthetic clinic for one scenario, so scenarios can't collide over
// a slot and can run in parallel. Deleted at the end of the scenario.
import { readFileSync } from "node:fs";
import { localToUtc } from "@/lib/booking/timezone";
import type { Db } from "@/lib/db/client";
import { TenantSeedSchema, WEEKDAY_NUMBERS } from "@/lib/db/seed-schema";
import { unwrap } from "@/lib/db/unwrap";

const SEED = TenantSeedSchema.parse(JSON.parse(readFileSync(new URL("../scripts/seed/tenant-fisio-demo.json", import.meta.url), "utf8")));

export type EvalTenant = {
  id: string;
  receivingNumber: string;
  timezone: string;
  prices: number[];
  services: Map<string, { id: string; durationMinutes: number }>;
  resources: Map<string, string>;
};

export async function seedEvalTenant(client: Db): Promise<EvalTenant> {
  const receivingNumber = `whatsapp:+1990${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const tenant = unwrap(
    await client
      .from("tenants")
      .insert({ ...SEED.tenant, name: "Fisio Aurora (eval)", receiving_number: receivingNumber, faq: SEED.faq })
      .select("id")
      .single(),
  ) as { id: string };

  const services = unwrap(
    await client
      .from("services")
      .insert(SEED.services.map((service) => ({ ...service, tenant_id: tenant.id })))
      .select("id, name, duration_minutes"),
  ) as { id: string; name: string; duration_minutes: number }[];
  const resources = unwrap(
    await client
      .from("resources")
      .insert(SEED.resources.map((resource) => ({ ...resource, tenant_id: tenant.id })))
      .select("id, name"),
  ) as { id: string; name: string }[];

  unwrap(
    await client
      .from("availability_rules")
      .insert(
        resources.flatMap((resource) =>
          SEED.availability_rules.weekly.map((row) => ({
            tenant_id: tenant.id,
            resource_id: resource.id,
            weekday: WEEKDAY_NUMBERS[row.weekday],
            opens: row.opens,
            closes: row.closes,
          })),
        ),
      )
      .select("id"),
  );
  unwrap(
    await client
      .from("availability_exceptions")
      .insert(SEED.availability_rules.closed_dates.map((date) => ({ tenant_id: tenant.id, resource_id: null, closed_date: date })))
      .select("id"),
  );

  return {
    id: tenant.id,
    receivingNumber,
    timezone: SEED.tenant.timezone,
    prices: SEED.services.map((service) => service.price),
    services: new Map(services.map((row) => [row.name, { id: row.id, durationMinutes: row.duration_minutes }])),
    resources: new Map(resources.map((row) => [row.name, row.id])),
  };
}

/** A booking row placed directly, for a scenario's setup (a taken slot, an existing appointment). */
export async function placeBooking(
  client: Db,
  tenant: EvalTenant,
  booking: { service: string; professional: string; date: string; time: string; customerId: string },
): Promise<string> {
  const service = tenant.services.get(booking.service);
  const resourceId = tenant.resources.get(booking.professional);
  if (!service || !resourceId) throw new Error(`Unknown service or professional in setup: ${booking.service} / ${booking.professional}`);
  const start = localToUtc({ date: booking.date, time: booking.time }, tenant.timezone);
  if (!start.ok) throw new Error(`Invalid setup time ${booking.date} ${booking.time}`);
  const end = new Date(start.at.getTime() + service.durationMinutes * 60_000);

  const row = unwrap(
    await client
      .from("bookings")
      .insert({
        tenant_id: tenant.id,
        customer_id: booking.customerId,
        service_id: service.id,
        resource_id: resourceId,
        during: `[${start.at.toISOString()},${end.toISOString()})`,
      })
      .select("id")
      .single(),
  ) as { id: string };
  return row.id;
}

/** Bookings first: their foreign keys to services and resources don't cascade. */
export async function dropEvalTenant(client: Db, tenantId: string): Promise<void> {
  unwrap(await client.from("bookings").delete().eq("tenant_id", tenantId).select("id"));
  unwrap(await client.from("tenants").delete().eq("id", tenantId).select("id"));
}
