import { callCostUsd } from "@/lib/cost/pricing";
import { redactPhones } from "@/lib/pii/redact";

const MAX_ERROR_LENGTH = 500;

/** The usage fields of an AI SDK result; both generateText and streamText report them. */
export type SdkUsage = {
  inputTokens: number | undefined;
  inputTokenDetails: {
    noCacheTokens: number | undefined;
    cacheReadTokens: number | undefined;
    cacheWriteTokens: number | undefined;
  };
  outputTokens: number | undefined;
};

export type ModelCallOutcome = "ok" | "error" | "timeout" | "invalid_output";

/** One row of agendo.model_calls. */
export type ModelCallRow = {
  tenant_id: string;
  conversation_id: string | null;
  purpose: string;
  model: string;
  chain_step: number;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  outcome: ModelCallOutcome;
  error: string | null;
};

export type CallSink = (row: ModelCallRow) => Promise<void>;

export type CallContext = {
  tenantId: string;
  conversationId: string | null;
  purpose: string;
  model: string;
  /** Position in the fallback chain: 0 is the primary model. */
  chainStep?: number;
};

export type RecordCallDeps = {
  sink: CallSink;
  nowMs?: () => number;
  onSinkError?: (error: unknown) => void;
};

function billedTokens(usage: SdkUsage) {
  const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const inputTokens =
    usage.inputTokenDetails.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens);
  return { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens: usage.outputTokens ?? 0 };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Runs one model call and writes one row whatever the outcome. The call's error is
 * rethrown; a failure to write the row is reported but never loses the model's answer.
 */
export async function recordCall<T extends { usage: SdkUsage }>(
  context: CallContext,
  deps: RecordCallDeps,
  run: () => PromiseLike<T>,
): Promise<T> {
  const nowMs = deps.nowMs ?? Date.now;
  // Checked first, so a missing price fails before money is spent.
  callCostUsd(context.model, { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });

  const row = {
    tenant_id: context.tenantId,
    conversation_id: context.conversationId,
    purpose: context.purpose,
    model: context.model,
    chain_step: context.chainStep ?? 0,
  };
  const write = async (result: Omit<ModelCallRow, keyof typeof row>) => {
    try {
      await deps.sink({ ...row, ...result });
    } catch (error) {
      (deps.onSinkError ?? console.error)(error);
    }
  };

  const startedAt = nowMs();
  try {
    const result = await run();
    const tokens = billedTokens(result.usage);
    await write({
      input_tokens: tokens.inputTokens,
      cache_write_tokens: tokens.cacheWriteTokens,
      cache_read_tokens: tokens.cacheReadTokens,
      output_tokens: tokens.outputTokens,
      cost_usd: callCostUsd(context.model, tokens),
      latency_ms: Math.max(0, Math.round(nowMs() - startedAt)),
      outcome: "ok",
      error: null,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await write({
      input_tokens: 0,
      cache_write_tokens: 0,
      cache_read_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: Math.max(0, Math.round(nowMs() - startedAt)),
      outcome: isTimeout(error) ? "timeout" : "error",
      error: redactPhones(message).slice(0, MAX_ERROR_LENGTH),
    });
    throw error;
  }
}
