// Prices copied from the pricing page, never estimated. Update the table and the
// date together, and only from the page itself.
import { FALLBACK_MODEL_CANDIDATE, PRIMARY_MODEL } from "@/lib/models";

export const PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const PRICING_READ_ON = "2026-11-08";

/** USD per 1M tokens, standard tier. cacheWrite is the 30-minute default, the only one this project uses. */
type Rates = { input: number; cacheWrite: number; cacheRead: number; output: number };

type ModelPrice = {
  rates: Rates;
  /** Applies to the whole request once its prompt passes overPromptTokens. */
  longPrompt?: { overPromptTokens: number; rates: Rates };
};

export const PRICES: Record<string, ModelPrice> = {
  [PRIMARY_MODEL]: {
    rates: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    longPrompt: {
      overPromptTokens: 272_000,
      rates: { input: 0.2, cacheWrite: 0.25, cacheRead: 0.02, output: 0.75 },
    },
  },
  [FALLBACK_MODEL_CANDIDATE]: {
    rates: { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
    longPrompt: {
      overPromptTokens: 272_000,
      rates: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 15 },
    },
  },
};

/** inputTokens excludes cached tokens: the three input counts add up to the prompt. */
export type BilledTokens = {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

export class UnknownModelPriceError extends Error {
  constructor(model: string) {
    super(`No price for "${model}" in lib/cost/pricing.ts. Copy it from ${PRICING_SOURCE} first.`);
    this.name = "UnknownModelPriceError";
  }
}

export function callCostUsd(model: string, tokens: BilledTokens): number {
  const price = PRICES[model];
  if (!price) throw new UnknownModelPriceError(model);

  const promptTokens = tokens.inputTokens + tokens.cacheWriteTokens + tokens.cacheReadTokens;
  const rates = price.longPrompt && promptTokens > price.longPrompt.overPromptTokens ? price.longPrompt.rates : price.rates;

  const perMillion =
    tokens.inputTokens * rates.input +
    tokens.cacheWriteTokens * rates.cacheWrite +
    tokens.cacheReadTokens * rates.cacheRead +
    tokens.outputTokens * rates.output;

  // Keep 8 decimals, matching numeric(12, 8), so a tiny call doesn't round to zero.
  return Math.round((perMillion / 1e6) * 1e8) / 1e8;
}
