import { localToday } from "@/lib/booking/availability";
import { addDays, localToUtc } from "@/lib/booking/timezone";
import type { SessionClient } from "@/lib/auth/server";
import { customerLabel, percentile, perLocalDay } from "@/lib/dashboard/metrics";
import { parseRange } from "./bookings";
import { unwrap } from "./unwrap";

const DAYS = 14;

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;

/** Start of a local date, as an instant. Midnight exists in every zone this app supports. */
function localMidnight(date: string, timezone: string): Date {
  const converted = localToUtc({ date, time: "00:00" }, timezone);
  return converted.ok ? converted.at : new Date(`${date}T00:00:00Z`);
}

/**
 * Everything on the dashboard, read as the signed-in owner. No query names a tenant to
 * filter by for safety: RLS returns only the owner's tenants' rows. The tenant filter
 * below only picks which of the owner's clinics to show.
 */
export async function loadDashboard(client: SessionClient, now: Date) {
  const tenants = unwrap(await client.from("tenants").select("id, name, timezone").order("name").limit(1)) as {
    id: string;
    name: string;
    timezone: string;
  }[];
  const tenant = tenants[0];
  if (!tenant) return null;

  const today = localToday(now, tenant.timezone);
  const monthStart = localMidnight(`${today.slice(0, 8)}01`, tenant.timezone);
  const windowStart = localMidnight(addDays(today, -(DAYS - 1)), tenant.timezone);
  const since = monthStart < windowStart ? monthStart : windowStart;

  const [calls, conversationsThisMonth, bookingsThisMonth, messages, upcoming, recent] = await Promise.all([
    client
      .from("model_calls")
      .select("created_at, cost_usd, latency_ms, outcome, chain_step")
      .eq("tenant_id", tenant.id)
      .gte("created_at", since.toISOString())
      .limit(10_000),
    client
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .gte("created_at", monthStart.toISOString()),
    client
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .gte("created_at", monthStart.toISOString()),
    client
      .from("messages")
      .select("created_at")
      .eq("tenant_id", tenant.id)
      .gte("created_at", windowStart.toISOString())
      .limit(20_000),
    client
      .from("bookings")
      .select("id, during, services(name), resources(name)")
      .eq("tenant_id", tenant.id)
      .eq("status", "confirmed")
      .overlaps("during", `[${now.toISOString()},)`)
      .order("during")
      .limit(10),
    // The customers grant hides the phone columns, so this names the columns it reads.
    client
      .from("conversations")
      .select("id, channel, status, last_customer_message_at, customers(id, display_name)")
      .eq("tenant_id", tenant.id)
      .order("last_customer_message_at", { ascending: false, nullsFirst: false })
      .limit(10),
  ]);

  type Call = { created_at: string; cost_usd: number; latency_ms: number; outcome: string; chain_step: number };
  const callRows = (unwrap(calls) as Call[]).map((row) => ({ ...row, cost_usd: Number(row.cost_usd) }));
  const monthCalls = callRows.filter((row) => new Date(row.created_at) >= monthStart);
  const latencies = monthCalls.filter((row) => row.outcome === "ok").map((row) => row.latency_ms);

  const at = (row: { created_at: string }) => row.created_at;
  type UpcomingRow = { id: string; during: string; services: { name: string } | null; resources: { name: string } | null };
  type RecentRow = {
    id: string;
    channel: string;
    status: string;
    last_customer_message_at: string | null;
    customers: { id: string; display_name: string | null } | null;
  };

  return {
    tenant,
    totals: {
      conversations: conversationsThisMonth.count ?? 0,
      bookings: bookingsThisMonth.count ?? 0,
      modelCostUsd: monthCalls.reduce((sum, row) => sum + row.cost_usd, 0),
      modelCalls: monthCalls.length,
      failedCalls: monthCalls.filter((row) => row.outcome !== "ok").length,
      fallbackCalls: monthCalls.filter((row) => row.chain_step > 0 && row.outcome === "ok").length,
      latencyP50: percentile(latencies, 50),
      latencyP95: percentile(latencies, 95),
    },
    messagesPerDay: perLocalDay(unwrap(messages) as { created_at: string }[], { timezone: tenant.timezone, now, days: DAYS, at }),
    costPerDay: perLocalDay(callRows, { timezone: tenant.timezone, now, days: DAYS, at, value: (row) => row.cost_usd }),
    upcoming: (unwrap(upcoming) as unknown as UpcomingRow[]).map((row) => ({
      id: row.id,
      start: parseRange(row.during).start,
      service: row.services?.name ?? "—",
      professional: row.resources?.name ?? "—",
    })),
    recent: (unwrap(recent) as unknown as RecentRow[]).map((row) => ({
      id: row.id,
      channel: row.channel,
      status: row.status,
      lastMessageAt: row.last_customer_message_at,
      customer: customerLabel(row.customers),
    })),
  };
}
