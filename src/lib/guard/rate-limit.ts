import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";

type Window = { tokens: number; window: `${number} ${"s" | "m" | "h" | "d"}` };

/** Starting values (open decision 4), to be tuned from measured traffic. */
export const CUSTOMER_WINDOWS: Window[] = [
  { tokens: 10, window: "1 m" },
  { tokens: 100, window: "1 d" },
];
export const WEB_IP_WINDOWS: Window[] = [
  { tokens: 20, window: "1 m" },
  { tokens: 200, window: "1 d" },
];

/** How long a Redis call may take before the limiter lets the request through. */
const REDIS_TIMEOUT_MS = 1_000;

export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };
export type RateLimiter = { check(key: string): Promise<RateDecision> };

/** One window's check, as Upstash reports it: whether it passed and when it resets (ms epoch). */
export type WindowCheck = (key: string) => Promise<{ success: boolean; reset: number }>;

export const allowAll: RateLimiter = { check: async () => ({ ok: true }) };

/**
 * Every window must pass. A Redis failure lets the request through: the budget still
 * caps spend, and a Redis outage shouldn't silence a clinic.
 */
export function windowedLimiter(
  windows: WindowCheck[],
  deps: { now: () => number; onError: (error: unknown) => void },
): RateLimiter {
  return {
    async check(key) {
      try {
        const results = await Promise.all(windows.map((check) => check(key)));
        const blocked = results.filter((result) => !result.success);
        if (blocked.length === 0) return { ok: true };
        const reset = Math.max(...blocked.map((result) => result.reset));
        return { ok: false, retryAfterMs: Math.max(0, reset - deps.now()) };
      } catch (error) {
        deps.onError(error);
        return { ok: true };
      }
    },
  };
}

/** Counters live in Redis because serverless instances share no memory. */
export function upstashLimiter(redis: Redis, prefix: string, windows: Window[], onError: (error: unknown) => void): RateLimiter {
  const checks = windows.map((window) => {
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(window.tokens, window.window),
      prefix: `agendo:rl:${prefix}:${window.window.replace(" ", "")}`,
      timeout: REDIS_TIMEOUT_MS,
      analytics: false,
    });
    return (key: string) => limiter.limit(key);
  });
  return windowedLimiter(checks, { now: Date.now, onError });
}
