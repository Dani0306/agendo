import { describe, expect, it } from "vitest";
import { FALLBACK_MODEL, PRIMARY_MODEL } from "@/lib/models";
import { callCostUsd, PRICES, PRICING_READ_ON, UnknownModelPriceError } from "./pricing";

const none = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

describe("callCostUsd", () => {
  it("prices every kind of token on the primary model, worked by hand", () => {
    // 1000 × 0.10 + 2000 × 0.125 + 3000 × 0.01 + 400 × 0.50 = 580 per million
    expect(
      callCostUsd(PRIMARY_MODEL, { inputTokens: 1000, cacheWriteTokens: 2000, cacheReadTokens: 3000, outputTokens: 400 }),
    ).toBe(0.00058);
  });

  it("keeps the normal rate at exactly 272,000 prompt tokens", () => {
    expect(callCostUsd(PRIMARY_MODEL, { ...none, inputTokens: 272_000 })).toBe(0.0272);
  });

  it("switches the whole request to the long-prompt rate above 272,000", () => {
    // 272,001 × 0.20 + 10 × 0.75 = 54,407.7 per million
    expect(callCostUsd(PRIMARY_MODEL, { ...none, inputTokens: 272_001, outputTokens: 10 })).toBe(0.0544077);
  });

  it("counts cached tokens toward the long-prompt threshold", () => {
    // 1 × 0.20 + 272,000 × 0.02 = 5,440.2 per million
    expect(callCostUsd(PRIMARY_MODEL, { ...none, inputTokens: 1, cacheReadTokens: 272_000 })).toBe(0.0054402);
  });

  it("prices the fallback candidate, including its long-prompt tier", () => {
    expect(callCostUsd(FALLBACK_MODEL, { ...none, inputTokens: 100_000 })).toBe(0.2);
    expect(callCostUsd(FALLBACK_MODEL, { ...none, inputTokens: 300_000 })).toBe(1.2);
  });

  it("throws on a model with no price", () => {
    expect(() => callCostUsd("claude-unknown", none)).toThrow(UnknownModelPriceError);
  });

  it("has a price for every model the app can call, and a read date", () => {
    expect(Object.keys(PRICES).sort()).toEqual([PRIMARY_MODEL, FALLBACK_MODEL].sort());
    expect(PRICING_READ_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
