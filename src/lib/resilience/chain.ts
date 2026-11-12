import { APICallError, type LanguageModel } from "ai";
import type { Breaker } from "./breaker";
import { type RetryDeps, statusOf, withRetry } from "./retry";

/** One step of the fallback chain. `id` names it in logs and in the breaker. */
export type ChainModel = {
  id: string;
  model: LanguageModel;
  /** The price row to bill under, when the id has none (only the chaos run's fake model). */
  priceModel?: string;
};

export type ChainDeps = {
  breaker: Breaker;
  retry: RetryDeps;
  log: (event: string, fields: Record<string, unknown>) => void;
};

export type StepOutcome = { model: string; reason: "breaker_open" | "failed"; status?: number };

/** Every model in the chain was skipped or failed. The caller falls through to the menu. */
export class ChainExhaustedError extends Error {
  constructor(readonly steps: StepOutcome[]) {
    super(`All models failed: ${steps.map((step) => `${step.model} ${step.reason}${step.status ? ` ${step.status}` : ""}`).join(", ")}`);
    this.name = "ChainExhaustedError";
  }
}

/**
 * A failure that moving to another model might fix: anything the provider answered
 * with, or a network failure. Our own deadline, a spent budget or a bug is rethrown
 * as it is, because another model can't help with those.
 */
export function isProviderFailure(error: unknown): boolean {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return false;
  return APICallError.isInstance(error) || error instanceof TypeError;
}

/**
 * Tries each model in order: skip it while its breaker is open, otherwise retry it
 * within the deadline, and on failure count it against its breaker and move on.
 */
export async function callChain<T>(
  steps: ChainModel[],
  deps: ChainDeps,
  options: { deadlineAt: number; fields: Record<string, unknown> },
  attempt: (step: ChainModel, index: number) => Promise<T>,
): Promise<{ value: T; index: number }> {
  const outcomes: StepOutcome[] = [];

  for (const [index, step] of steps.entries()) {
    if (!(await deps.breaker.allow(step.id))) {
      deps.log("chain.skipped", { ...options.fields, model: step.id, step: index, reason: "breaker_open" });
      outcomes.push({ model: step.id, reason: "breaker_open" });
      continue;
    }

    try {
      const value = await withRetry(() => attempt(step, index), { deadlineAt: options.deadlineAt }, {
        ...deps.retry,
        onRetry: (info) => deps.log("chain.retry", { ...options.fields, model: step.id, step: index, ...info }),
      });
      await deps.breaker.success(step.id);
      if (index > 0) deps.log("chain.fallback_served", { ...options.fields, model: step.id, step: index });
      return { value, index };
    } catch (error) {
      if (!isProviderFailure(error)) throw error;
      await deps.breaker.failure(step.id);
      const status = statusOf(error);
      deps.log("chain.failed", { ...options.fields, model: step.id, step: index, status: status ?? null });
      outcomes.push({ model: step.id, reason: "failed", ...(status ? { status } : {}) });
    }
  }

  throw new ChainExhaustedError(outcomes);
}
