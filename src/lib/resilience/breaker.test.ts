import { beforeEach, describe, expect, it, vi } from "vitest";
import { BREAKER, type BreakerStore, circuitBreaker, memoryBreakerStore } from "./breaker";

let clock: number;
let breaker: ReturnType<typeof circuitBreaker>;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

beforeEach(() => {
  clock = 1_000_000;
  onError = vi.fn<(error: unknown) => void>();
  breaker = circuitBreaker(memoryBreakerStore(() => clock), { now: () => clock, onError });
});

async function failTimes(n: number, name = "m") {
  for (let index = 0; index < n; index += 1) await breaker.failure(name);
}

describe("circuitBreaker", () => {
  it("stays closed below the threshold", async () => {
    await failTimes(BREAKER.failureThreshold - 1);
    expect(await breaker.allow("m")).toBe(true);
  });

  it("opens at the threshold and blocks during the cool-down", async () => {
    await failTimes(BREAKER.failureThreshold);
    expect(await breaker.allow("m")).toBe(false);
    clock += BREAKER.cooldownMs - 1;
    expect(await breaker.allow("m")).toBe(false);
  });

  it("forgets failures older than the window", async () => {
    await failTimes(BREAKER.failureThreshold - 1);
    clock += BREAKER.windowMs;
    await breaker.failure("m");
    expect(await breaker.allow("m")).toBe(true);
  });

  it("lets exactly one probe through after the cool-down", async () => {
    await failTimes(BREAKER.failureThreshold);
    clock += BREAKER.cooldownMs;
    expect(await breaker.allow("m")).toBe(true);
    expect(await breaker.allow("m")).toBe(false);
  });

  it("closes when the probe succeeds", async () => {
    await failTimes(BREAKER.failureThreshold);
    clock += BREAKER.cooldownMs;
    await breaker.allow("m");
    await breaker.success("m");
    expect(await breaker.allow("m")).toBe(true);
    expect(await breaker.allow("m")).toBe(true);
  });

  it("opens again for a full cool-down when the probe fails", async () => {
    await failTimes(BREAKER.failureThreshold);
    clock += BREAKER.cooldownMs;
    await breaker.allow("m");
    await breaker.failure("m");
    expect(await breaker.allow("m")).toBe(false);
    clock += BREAKER.cooldownMs;
    expect(await breaker.allow("m")).toBe(true);
  });

  it("lets another probe through if the first never reported back", async () => {
    await failTimes(BREAKER.failureThreshold);
    clock += BREAKER.cooldownMs;
    await breaker.allow("m");
    clock += BREAKER.probeMs;
    expect(await breaker.allow("m")).toBe(true);
  });

  it("keeps models apart", async () => {
    await failTimes(BREAKER.failureThreshold, "a");
    expect(await breaker.allow("a")).toBe(false);
    expect(await breaker.allow("b")).toBe(true);
  });

  it("lets calls through when the store fails, and reports it", async () => {
    const broken: BreakerStore = {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => undefined,
      setIfAbsent: async () => true,
      increment: async () => {
        throw new Error("redis down");
      },
      remove: async () => undefined,
    };
    const failing = circuitBreaker(broken, { now: () => clock, onError });
    expect(await failing.allow("m")).toBe(true);
    await failing.failure("m");
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
