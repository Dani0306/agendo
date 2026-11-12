import { type Budget, DEFAULT_MONTHLY_BUDGET_USD, type Reservation, toStoredUsd } from "@/lib/guard/budget";
import type { Db } from "./client";
import { unwrap } from "./unwrap";

/** Each step is one atomic statement in Postgres (see 20261112130000_budget.sql). */
export function postgresBudget(client: Db): Budget {
  return {
    async reserve(tenantId, usd) {
      const { data, error } = await client.rpc("reserve_budget", {
        p_tenant: tenantId,
        p_amount: toStoredUsd(usd),
        p_default_limit: DEFAULT_MONTHLY_BUDGET_USD,
      });
      if (error) unwrap({ data: null, error });
      return typeof data === "string" ? { tenantId, month: data, usd: toStoredUsd(usd) } : null;
    },

    async settle(reservation: Reservation, actualUsd: number) {
      const { error } = await client.rpc("settle_budget", {
        p_tenant: reservation.tenantId,
        p_month: reservation.month,
        p_reserved: reservation.usd,
        p_actual: toStoredUsd(actualUsd),
      });
      if (error) unwrap({ data: null, error });
    },

    async refund(reservation: Reservation) {
      const { error } = await client.rpc("refund_budget", {
        p_tenant: reservation.tenantId,
        p_month: reservation.month,
        p_reserved: reservation.usd,
      });
      if (error) unwrap({ data: null, error });
    },
  };
}

/** Total model cost for a tenant since a moment, from model_calls. */
export async function modelSpendSince(client: Db, tenantId: string, since: Date): Promise<number> {
  const { data, error } = await client.rpc("model_spend_since", { p_tenant: tenantId, p_since: since.toISOString() });
  if (error) unwrap({ data: null, error });
  return Number(data ?? 0);
}
