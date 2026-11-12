import { callCostUsd } from "@/lib/cost/pricing";

/** Used when a tenant's monthly_budget_usd is null (open decision 4). */
export const DEFAULT_MONTHLY_BUDGET_USD = 5;
/** Bounds the worst case a reservation has to cover. */
export const MAX_OUTPUT_TOKENS = 600;
/** The web demo's cap across all visitors, counted from model_calls. */
export const DEMO_DAILY_CAP_USD = 0.5;
/** A conservative token estimate: Spanish text averages more than three characters a token. */
const CHARS_PER_TOKEN = 3;

export type Reservation = { tenantId: string; month: string; usd: number };

/** Reserve before a model call; settle with the real cost after it, or refund if it failed. */
export type Budget = {
  reserve(tenantId: string, usd: number): Promise<Reservation | null>;
  settle(reservation: Reservation, actualUsd: number): Promise<void>;
  refund(reservation: Reservation): Promise<void>;
};

/** Up to the 8 decimals tenant_usage stores, rounded up so a reservation never undercounts. */
export function toStoredUsd(usd: number): number {
  return Math.ceil(usd * 1e8) / 1e8;
}

/** The most one call can cost: every input token uncached, and the full output allowance. */
export function estimateCallUsd(model: string, promptChars: number): number {
  return toStoredUsd(
    callCostUsd(model, {
      inputTokens: Math.ceil(promptChars / CHARS_PER_TOKEN),
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: MAX_OUTPUT_TOKENS,
    }),
  );
}

export const unlimitedBudget: Budget = {
  reserve: async (tenantId, usd) => ({ tenantId, month: "unlimited", usd }),
  settle: async () => undefined,
  refund: async () => undefined,
};
