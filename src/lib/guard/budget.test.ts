import { describe, expect, it } from "vitest";
import { PRIMARY_MODEL } from "@/lib/models";
import { estimateCallUsd, MAX_OUTPUT_TOKENS, toStoredUsd } from "./budget";

describe("estimateCallUsd", () => {
  it("prices every input token uncached plus the full output allowance", () => {
    // gpt-6-luna, 8 Nov 2026: $0.10 input and $0.50 output per 1M tokens.
    const usd = estimateCallUsd(PRIMARY_MODEL, 30_000);
    expect(usd).toBeCloseTo((10_000 * 0.1 + MAX_OUTPUT_TOKENS * 0.5) / 1e6, 8);
  });

  it("refuses a model with no price", () => {
    expect(() => estimateCallUsd("no-such-model", 10)).toThrow();
  });
});

describe("toStoredUsd", () => {
  it("rounds up to 8 decimals", () => {
    expect(toStoredUsd(0.000000011)).toBe(0.00000002);
    expect(toStoredUsd(0.5)).toBe(0.5);
  });
});
