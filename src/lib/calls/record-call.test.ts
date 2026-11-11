import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { UnknownModelPriceError } from "@/lib/cost/pricing";
import { PRIMARY_MODEL } from "@/lib/models";
import { type ModelCallRow, recordCall } from "./record-call";
import { jsonlSink } from "./sinks";

const context = { tenantId: "tenant-1", conversationId: "conv-1", purpose: "reply", model: PRIMARY_MODEL };

function mockModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "Hola" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 6000, noCache: 1000, cacheRead: 3000, cacheWrite: 2000 },
        outputTokens: { total: 400, text: 400, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function collect() {
  const rows: ModelCallRow[] = [];
  return { rows, sink: async (row: ModelCallRow) => void rows.push(row) };
}

describe("recordCall", () => {
  it("records tokens and cost from a real SDK result", async () => {
    const { rows, sink } = collect();
    let now = 1000;
    const result = await recordCall(context, { sink, nowMs: () => (now += 250) }, () =>
      generateText({ model: mockModel(), prompt: "Hola" }),
    );

    expect(result.text).toBe("Hola");
    expect(rows).toEqual([
      {
        tenant_id: "tenant-1",
        conversation_id: "conv-1",
        purpose: "reply",
        model: PRIMARY_MODEL,
        chain_step: 0,
        input_tokens: 1000,
        cache_write_tokens: 2000,
        cache_read_tokens: 3000,
        output_tokens: 400,
        cost_usd: 0.00058,
        latency_ms: 250,
        outcome: "ok",
        error: null,
      },
    ]);
  });

  it("writes a row and rethrows when the call fails, with the phone removed", async () => {
    const { rows, sink } = collect();
    const failure = new Error("could not reach whatsapp:+573000000001");

    await expect(recordCall(context, { sink }, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "error", input_tokens: 0, cost_usd: 0, error: "could not reach [phone]" });
  });

  it("marks an aborted call as a timeout", async () => {
    const { rows, sink } = collect();
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });

    await expect(recordCall(context, { sink }, () => Promise.reject(aborted))).rejects.toBe(aborted);

    expect(rows[0].outcome).toBe("timeout");
  });

  it("records the fallback chain step", async () => {
    const { rows, sink } = collect();
    await recordCall({ ...context, chainStep: 1 }, { sink }, () => generateText({ model: mockModel(), prompt: "Hola" }));
    expect(rows[0].chain_step).toBe(1);
  });

  it("keeps the answer when the row cannot be written", async () => {
    const onSinkError = vi.fn();
    const sink = () => Promise.reject(new Error("database down"));

    const result = await recordCall(context, { sink, onSinkError }, () =>
      generateText({ model: mockModel(), prompt: "Hola" }),
    );

    expect(result.text).toBe("Hola");
    expect(onSinkError).toHaveBeenCalledOnce();
  });

  it("refuses an unpriced model before calling it", async () => {
    const { sink } = collect();
    const run = vi.fn();

    await expect(recordCall({ ...context, model: "claude-unknown" }, { sink }, run)).rejects.toThrow(UnknownModelPriceError);

    expect(run).not.toHaveBeenCalled();
  });
});

describe("jsonlSink", () => {
  it("appends one line per call", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agendo-")), "logs", "model-calls.jsonl");
    const sink = jsonlSink(path);
    const row = { tenant_id: "t" } as ModelCallRow;

    await sink(row);
    await sink(row);

    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
