import { describe, expect, it, vi } from "vitest";
import { windowedLimiter, type WindowCheck } from "./rate-limit";

const NOW = 1_000_000;

function counter(limit: number, reset: number): WindowCheck {
  const used = new Map<string, number>();
  return async (key) => {
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    return { success: count <= limit, reset };
  };
}

describe("windowedLimiter", () => {
  it("lets requests through until a window is used up, per key", async () => {
    const limiter = windowedLimiter([counter(2, NOW + 60_000)], { now: () => NOW, onError: vi.fn() });
    expect(await limiter.check("a")).toEqual({ ok: true });
    expect(await limiter.check("a")).toEqual({ ok: true });
    expect(await limiter.check("a")).toEqual({ ok: false, retryAfterMs: 60_000 });
    expect(await limiter.check("b")).toEqual({ ok: true });
  });

  it("blocks when any window is used up, waiting for the latest reset", async () => {
    const limiter = windowedLimiter([counter(1, NOW + 60_000), counter(1, NOW + 86_400_000)], { now: () => NOW, onError: vi.fn() });
    await limiter.check("a");
    expect(await limiter.check("a")).toEqual({ ok: false, retryAfterMs: 86_400_000 });
  });

  it("lets the request through when Redis fails, and reports it", async () => {
    const onError = vi.fn();
    const failing: WindowCheck = async () => {
      throw new Error("redis down");
    };
    const limiter = windowedLimiter([failing], { now: () => NOW, onError });
    expect(await limiter.check("a")).toEqual({ ok: true });
    expect(onError).toHaveBeenCalledOnce();
  });
});
