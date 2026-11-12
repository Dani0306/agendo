import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { backoffMs, isRetryable, RETRY, withRetry } from "./retry";

function apiError(statusCode: number | undefined) {
  return new APICallError({ message: `HTTP ${statusCode}`, url: "https://api.test", requestBodyValues: {}, statusCode });
}

function timeoutError() {
  const error = new Error("timed out");
  error.name = "TimeoutError";
  return error;
}

describe("isRetryable", () => {
  it.each([408, 429, 500, 502, 503, 529])("retries %s", (status) => {
    expect(isRetryable(apiError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("never retries %s", (status) => {
    expect(isRetryable(apiError(status))).toBe(false);
  });

  it("retries a network failure with no status", () => {
    expect(isRetryable(apiError(undefined))).toBe(true);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });

  it("doesn't retry once our own deadline fired", () => {
    expect(isRetryable(timeoutError())).toBe(false);
  });

  it("doesn't retry an unknown error", () => {
    expect(isRetryable(new Error("bug"))).toBe(false);
  });
});

describe("backoffMs", () => {
  it("grows exponentially up to the cap, scaled by the random draw", () => {
    expect(backoffMs(0, () => 1)).toBe(250);
    expect(backoffMs(1, () => 1)).toBe(500);
    expect(backoffMs(4, () => 1)).toBe(RETRY.capMs);
    expect(backoffMs(1, () => 0.5)).toBe(250);
    expect(backoffMs(3, () => 0)).toBe(0);
  });
});

describe("withRetry", () => {
  const deps = (now = 0) => ({ now: () => now, sleep: vi.fn(async () => undefined), random: () => 1, onRetry: vi.fn() });

  it("returns the first success", async () => {
    const run = vi.fn().mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce("ok");
    const d = deps();
    expect(await withRetry(run, { deadlineAt: 60_000 }, d)).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(250);
    expect(d.onRetry).toHaveBeenCalledWith({ attempt: 0, waitMs: 250, status: 503 });
  });

  it("stops after the last attempt and throws its error", async () => {
    const run = vi.fn().mockRejectedValue(apiError(429));
    await expect(withRetry(run, { deadlineAt: 60_000 }, deps())).rejects.toThrow("HTTP 429");
    expect(run).toHaveBeenCalledTimes(RETRY.maxAttempts);
  });

  it("fails at once on a revoked key", async () => {
    const run = vi.fn().mockRejectedValue(apiError(401));
    const d = deps();
    await expect(withRetry(run, { deadlineAt: 60_000 }, d)).rejects.toThrow("HTTP 401");
    expect(run).toHaveBeenCalledOnce();
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("won't wait past the deadline", async () => {
    const run = vi.fn().mockRejectedValue(apiError(503));
    // 250 ms wait + 1 s minimum would end at 1,250 ms, after the 1,000 ms deadline.
    await expect(withRetry(run, { deadlineAt: 1_000 }, deps())).rejects.toThrow("HTTP 503");
    expect(run).toHaveBeenCalledOnce();
  });
});
