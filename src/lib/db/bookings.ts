import type { BookingStore, Service, StoredBooking } from "@/lib/tools/store";
import type { Db } from "./client";
import { markConversationHandoff } from "./conversations";
import { DbError, unwrap } from "./unwrap";

const EXCLUSION_VIOLATION = "23P01";

const BOOKING_COLUMNS =
  "id, during, resource_id, service_id, resources(name), services(name, duration_minutes)";

type BookingRow = {
  id: string;
  during: string;
  resource_id: string;
  service_id: string;
  resources: { name: string };
  services: { name: string; duration_minutes: number };
};

/** Postgres prints a timestamptz as `2030-01-07 15:00:00+00`, which Date doesn't accept everywhere. */
function parseTimestamp(text: string): Date {
  const iso = text
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw new Error("Unreadable timestamp in a range");
  return parsed;
}

/** Reads a `["start","end")` range as Postgres returns it. */
export function parseRange(range: string): { start: Date; end: Date } {
  const [start, end] = range
    .slice(1, -1)
    .split(",")
    .map((part) => part.replaceAll('"', ""));
  if (!start || !end) throw new Error("Unreadable range");
  return { start: parseTimestamp(start), end: parseTimestamp(end) };
}

export function formatRange(start: Date, end: Date): string {
  return `[${start.toISOString()},${end.toISOString()})`;
}

function toBooking(row: BookingRow): StoredBooking {
  return {
    id: row.id,
    resourceId: row.resource_id,
    resourceName: row.resources.name,
    serviceId: row.service_id,
    serviceName: row.services.name,
    serviceDurationMinutes: row.services.duration_minutes,
    ...parseRange(row.during),
  };
}

/** A row, or null when the exclusion constraint refused the slot. */
function writtenRow(result: { data: unknown; error: { message: string; code?: string } | null }): StoredBooking | null {
  if (result.error?.code === EXCLUSION_VIOLATION) return null;
  if (result.error) throw new DbError(result.error);
  return toBooking(result.data as BookingRow);
}

/** The secret key bypasses RLS, so every query here filters by tenant_id itself. */
export function bookingStore(client: Db): BookingStore {
  return {
    async catalog(tenantId) {
      const [tenant, services, resources, rules, closures] = await Promise.all([
        client.from("tenants").select("timezone").eq("id", tenantId).single(),
        client.from("services").select("id, name, duration_minutes").eq("tenant_id", tenantId).eq("active", true).order("name"),
        client.from("resources").select("id, name").eq("tenant_id", tenantId).eq("active", true).order("name"),
        client.from("availability_rules").select("resource_id, weekday, opens, closes").eq("tenant_id", tenantId),
        client.from("availability_exceptions").select("resource_id, closed_date").eq("tenant_id", tenantId),
      ]);

      type RuleRow = { resource_id: string; weekday: number; opens: string; closes: string };
      type ClosureRow = { resource_id: string | null; closed_date: string };
      type ServiceRow = { id: string; name: string; duration_minutes: number };

      return {
        schedule: {
          timezone: (unwrap(tenant) as { timezone: string }).timezone,
          resources: unwrap(resources) as { id: string; name: string }[],
          rules: (unwrap(rules) as RuleRow[]).map((row) => ({
            resourceId: row.resource_id,
            weekday: row.weekday,
            opens: row.opens.slice(0, 5),
            closes: row.closes.slice(0, 5),
          })),
          closures: (unwrap(closures) as ClosureRow[]).map((row) => ({ resourceId: row.resource_id, date: row.closed_date })),
        },
        services: (unwrap(services) as ServiceRow[]).map(
          (row): Service => ({ id: row.id, name: row.name, durationMinutes: row.duration_minutes }),
        ),
      };
    },

    async busyPeriods(tenantId, from, to) {
      const rows = unwrap(
        await client
          .from("bookings")
          .select("resource_id, during")
          .eq("tenant_id", tenantId)
          .eq("status", "confirmed")
          .overlaps("during", formatRange(from, to)),
      ) as { resource_id: string; during: string }[];
      return rows.map((row) => ({ resourceId: row.resource_id, ...parseRange(row.during) }));
    },

    async upcomingBookings(tenantId, customerId, now) {
      const rows = unwrap(
        await client
          .from("bookings")
          .select(BOOKING_COLUMNS)
          .eq("tenant_id", tenantId)
          .eq("customer_id", customerId)
          .eq("status", "confirmed")
          .overlaps("during", `[${now.toISOString()},)`)
          .order("during"),
      ) as unknown as BookingRow[];
      return rows.map(toBooking);
    },

    async insertBooking(request) {
      return writtenRow(
        await client
          .from("bookings")
          .insert({
            tenant_id: request.tenantId,
            customer_id: request.customerId,
            service_id: request.serviceId,
            resource_id: request.resourceId,
            during: formatRange(request.start, request.end),
          })
          .select(BOOKING_COLUMNS)
          .single(),
      );
    },

    async moveBooking({ tenantId, customerId, bookingId }, target) {
      return writtenRow(
        await client
          .from("bookings")
          .update({ resource_id: target.resourceId, during: formatRange(target.start, target.end) })
          .eq("tenant_id", tenantId)
          .eq("customer_id", customerId)
          .eq("id", bookingId)
          .eq("status", "confirmed")
          .select(BOOKING_COLUMNS)
          .single(),
      );
    },

    async cancelBooking({ tenantId, customerId, bookingId }) {
      const rows = unwrap(
        await client
          .from("bookings")
          .update({ status: "cancelled" })
          .eq("tenant_id", tenantId)
          .eq("customer_id", customerId)
          .eq("id", bookingId)
          .eq("status", "confirmed")
          .select("id"),
      ) as unknown[];
      return rows.length === 1;
    },

    markHandoff: (tenantId, conversationId) => markConversationHandoff(client, tenantId, conversationId),
  };
}
