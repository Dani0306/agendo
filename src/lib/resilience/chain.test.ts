import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { circuitBreaker, memoryBreakerStore } from "./breaker";
import { ChainExhaustedError, callChain, isProviderFailure } from "./chain";

const model = new MockLanguageModelV4({});
const steps = [
  { id: "a", model },
  { id: "b", model },
];

function apiError(statusCode: number) {
  return new APICallError({ message: `HTTP ${statusCode}`, url: "https://api.test", requestBodyValues: {}, statusCode });
}

function deps() {
  const now = () => 0;
  return {
    breaker: circuitBreaker(memoryBreakerStore(now), { now, onError: vi.fn() }),
    retry: { now, sleep: async () => undefined, random: () => 0 },
    log: vi.fn(),
  };
}

const options = { deadlineAt: 60_000, fields: {} };

describe("isProviderFailure", () => {
  it("moves on for anything the provider answered, or a network failure", () => {
    expect(isProviderFailure(apiError(401))).toBe(true);
    expect(isProviderFailure(apiError(500))).toBe(true);
    expect(isProviderFailure(new TypeError("fetch failed"))).toBe(true);
  });

  it("doesn't move on for our own deadline or a bug", () => {
    const timeout = new Error("t");
    timeout.name = "TimeoutError";
    expect(isProviderFailure(timeout)).toBe(false);
    expect(isProviderFailure(new Error("bug"))).toBe(false);
  });
});

describe("callChain", () => {
  it("returns the first model that answers, and its position", async () => {
    const attempt = vi.fn(async (step: { id: string }) => {
      if (step.id === "a") throw apiError(404);
      return "from b";
    });
    expect(await callChain(steps, deps(), options, attempt)).toEqual({ value: "from b", index: 1 });
  });

  it("throws ChainExhaustedError naming each step when all fail", async () => {
    const error = await callChain(steps, deps(), options, async () => {
      throw apiError(401);
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChainExhaustedError);
    expect((error as ChainExhaustedError).steps).toEqual([
      { model: "a", reason: "failed", status: 401 },
      { model: "b", reason: "failed", status: 401 },
    ]);
  });

  it("rethrows an error another model can't fix, without trying the next one", async () => {
    const attempt = vi.fn(async () => {
      throw new Error("over budget");
    });
    await expect(callChain(steps, deps(), options, attempt)).rejects.toThrow("over budget");
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("logs when the fallback served", async () => {
    const d = deps();
    await callChain(steps, d, options, async (step) => {
      if (step.id === "a") throw apiError(500);
      return "ok";
    });
    expect(d.log).toHaveBeenCalledWith("chain.fallback_served", { model: "b", step: 1 });
  });
});
