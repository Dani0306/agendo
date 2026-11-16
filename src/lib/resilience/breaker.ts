import type { Redis } from "@upstash/redis";

export type BreakerConfig = { failureThreshold: number; windowMs: number; cooldownMs: number; probeMs: number };

/** 3 failures within 60 s open it for 30 s; then one probe at a time, each with 10 s to report. */
export const BREAKER: BreakerConfig = { failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000, probeMs: 10_000 };

/** How long the open marker outlives its cool-down, so a half-open breaker remembers it was open. */
const OPEN_MARKER_EXTRA_MS = 10 * 60_000;

/** The few key-value operations the breaker needs. Redis in production, memory in tests. */
export type BreakerStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** True if this call created the key: only one caller wins. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Increments, setting the expiry when the key is new. */
  increment(key: string, ttlMs: number): Promise<number>;
  remove(...keys: string[]): Promise<void>;
};

export type Breaker = {
  /** False while the breaker is open. After the cool-down, true for exactly one probe. */
  allow(name: string): Promise<boolean>;
  success(name: string): Promise<void>;
  failure(name: string): Promise<void>;
};

/**
 * Closed: calls flow, failures are counted in a window.
 * Open: no calls until the cool-down ends.
 * Half-open: one probe; success closes, failure opens again for another cool-down.
 * Any store error lets the call through: a broken breaker must not take the agent down.
 */
export function circuitBreaker(
  store: BreakerStore,
  deps: { now: () => number; onError: (error: unknown) => void },
  config: BreakerConfig = BREAKER,
): Breaker {
  const keys = (name: string) => ({
    open: `agendo:cb:${name}:open_until`,
    failures: `agendo:cb:${name}:failures`,
    probe: `agendo:cb:${name}:probe`,
  });

  const open = async (name: string) => {
    const key = keys(name);
    await store.set(key.open, String(deps.now() + config.cooldownMs), config.cooldownMs + OPEN_MARKER_EXTRA_MS);
    await store.remove(key.failures, key.probe);
  };

  return {
    async allow(name) {
      try {
        const key = keys(name);
        const openUntil = await store.get(key.open);
        if (openUntil === null) return true;
        if (deps.now() < Number(openUntil)) return false;
        return await store.setIfAbsent(key.probe, "1", config.probeMs);
      } catch (error) {
        deps.onError(error);
        return true;
      }
    },

    async success(name) {
      try {
        const key = keys(name);
        await store.remove(key.open, key.failures, key.probe);
      } catch (error) {
        deps.onError(error);
      }
    },

    async failure(name) {
      try {
        const key = keys(name);
        const openUntil = await store.get(key.open);
        // A failed probe: straight back to open.
        if (openUntil !== null && deps.now() >= Number(openUntil)) {
          await open(name);
          return;
        }
        const count = await store.increment(key.failures, config.windowMs);
        if (count >= config.failureThreshold) await open(name);
      } catch (error) {
        deps.onError(error);
      }
    },
  };
}

/** Redis-backed: every serverless instance sees the same breaker. */
export function redisBreakerStore(redis: Redis): BreakerStore {
  return {
    get: async (key) => {
      const value = await redis.get<string | number>(key);
      return value === null || value === undefined ? null : String(value);
    },
    set: async (key, value, ttlMs) => {
      await redis.set(key, value, { px: ttlMs });
    },
    setIfAbsent: async (key, value, ttlMs) => (await redis.set(key, value, { px: ttlMs, nx: true })) === "OK",
    increment: async (key, ttlMs) => {
      const count = await redis.incr(key);
      if (count === 1) await redis.pexpire(key, ttlMs);
      return count;
    },
    remove: async (...keys) => {
      if (keys.length > 0) await redis.del(...keys);
    },
  };
}

/** Per process: for tests, and for scripts in development without Upstash. */
export function memoryBreakerStore(now: () => number): BreakerStore {
  const entries = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() >= entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    return entry;
  };
  return {
    get: async (key) => live(key)?.value ?? null,
    set: async (key, value, ttlMs) => {
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    setIfAbsent: async (key, value, ttlMs) => {
      if (live(key)) return false;
      entries.set(key, { value, expiresAt: now() + ttlMs });
      return true;
    },
    increment: async (key, ttlMs) => {
      const entry = live(key);
      const count = (entry ? Number(entry.value) : 0) + 1;
      entries.set(key, { value: String(count), expiresAt: entry?.expiresAt ?? now() + ttlMs });
      return count;
    },
    remove: async (...keys) => {
      for (const key of keys) entries.delete(key);
    },
  };
}
