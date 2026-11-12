import { APICallError } from "ai";

export type RetryConfig = { maxAttempts: number; baseMs: number; capMs: number; minRemainingMs: number };

/** At most 3 attempts per model; waits capped at 2 s; never start one with under 1 s left. */
export const RETRY: RetryConfig = { maxAttempts: 3, baseMs: 250, capMs: 2_000, minRemainingMs: 1_000 };

export type RetryDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  onRetry?: (info: { attempt: number; waitMs: number; status: number | undefined }) => void;
};

export function statusOf(error: unknown): number | undefined {
  return APICallError.isInstance(error) ? error.statusCode : undefined;
}

/**
 * Worth trying again: a timeout from the provider (408), rate limiting (429), a server
 * error (5xx), or a network failure with no status at all. A 4xx like 400, 401, 403 or
 * 404 means the request itself is wrong and won't get better. Our own deadline firing
 * (TimeoutError or AbortError) is not retried either: there is no time left to do it.
 */
export function isRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    return status === undefined || status === 408 || status === 429 || status >= 500;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return false;
  return error instanceof TypeError; // fetch's network failure
}

/** Full jitter: a random wait up to the exponential ceiling, so clients don't retry in step. */
export function backoffMs(attempt: number, random: () => number, config: RetryConfig = RETRY): number {
  return Math.floor(random() * Math.min(config.capMs, config.baseMs * 2 ** attempt));
}

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: { deadlineAt: number },
  deps: RetryDeps,
  config: RetryConfig = RETRY,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt + 1 >= config.maxAttempts || !isRetryable(error)) throw error;
      const waitMs = backoffMs(attempt, deps.random, config);
      // Inside the turn's deadline, or not at all: a late answer is as bad as none.
      if (deps.now() + waitMs + config.minRemainingMs > options.deadlineAt) throw error;
      deps.onRetry?.({ attempt, waitMs, status: statusOf(error) });
      await deps.sleep(waitMs);
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
