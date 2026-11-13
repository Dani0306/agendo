import { localToday } from "@/lib/booking/availability";
import { addDays, utcToLocal } from "@/lib/booking/timezone";

/** Nearest-rank percentile; null when there is nothing to measure. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/** One entry per local day, oldest first, including days with nothing. */
export function perLocalDay<T>(
  rows: T[],
  options: { timezone: string; now: Date; days: number; at: (row: T) => string; value?: (row: T) => number },
): { date: string; total: number }[] {
  const today = localToday(options.now, options.timezone);
  const dates = Array.from({ length: options.days }, (_, index) => addDays(today, index - options.days + 1));
  const totals = new Map(dates.map((date) => [date, 0]));
  for (const row of rows) {
    const date = utcToLocal(new Date(options.at(row)), options.timezone).date;
    if (totals.has(date)) totals.set(date, totals.get(date)! + (options.value ? options.value(row) : 1));
  }
  return dates.map((date) => ({ date, total: totals.get(date)! }));
}

/** No phone numbers on the dashboard: a name if the customer gave one, else a short id. */
export function customerLabel(customer: { id: string; display_name: string | null } | null): string {
  if (!customer) return "Paciente";
  return customer.display_name?.trim() || `Paciente ·${customer.id.slice(-4)}`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}
