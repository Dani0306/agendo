// Measures what prompt caching saves: the same scripted conversation with caching off
// (explicit mode, no breakpoints) and on (implicit, the default). Writes a run file to
// evals/runs/. Costs money: about $0.002 for both arms, stopped at a cap.
import { mkdir, writeFile } from "node:fs/promises";
import { callCostUsd, PRICES, PRICING_READ_ON, PRICING_SOURCE } from "@/lib/cost/pricing";
import { PRIMARY_MODEL } from "@/lib/models";
import { type CallRow, runScriptedConversation } from "./lib/scripted-conversation";

const MAX_USD_PER_ARM = 0.025;

function summarize(calls: CallRow[]) {
  const sum = (field: keyof CallRow) => calls.reduce((total, call) => total + Number(call[field]), 0);
  const promptTokens = sum("input_tokens") + sum("cache_write_tokens") + sum("cache_read_tokens");
  // What the same calls would have cost with every input token billed uncached.
  const uncachedUsd = calls.reduce(
    (total, call) =>
      total +
      callCostUsd(PRIMARY_MODEL, {
        inputTokens: call.input_tokens + call.cache_write_tokens + call.cache_read_tokens,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: call.output_tokens,
      }),
    0,
  );
  const latencies = calls.map((call) => call.latency_ms).sort((a, b) => a - b);
  return {
    calls: calls.length,
    prompt_tokens: promptTokens,
    input_tokens: sum("input_tokens"),
    cache_write_tokens: sum("cache_write_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    output_tokens: sum("output_tokens"),
    cost_usd: Number(sum("cost_usd").toFixed(8)),
    uncached_cost_usd: Number(uncachedUsd.toFixed(8)),
    cache_read_share: promptTokens === 0 ? 0 : Number((sum("cache_read_tokens") / promptTokens).toFixed(4)),
    cost_per_call_usd: calls.length === 0 ? 0 : Number((sum("cost_usd") / calls.length).toFixed(8)),
    median_latency_ms: latencies[Math.floor(latencies.length / 2)] ?? 0,
  };
}

async function main() {
  console.log("Arm 1 of 2: prompt caching off");
  const off = await runScriptedConversation({ promptCache: "off", maxUsd: MAX_USD_PER_ARM, quiet: true });
  console.log("Arm 2 of 2: prompt caching on");
  const on = await runScriptedConversation({ promptCache: "implicit", maxUsd: MAX_USD_PER_ARM, quiet: true });

  const offSummary = summarize(off.calls);
  const onSummary = summarize(on.calls);
  const perCallSaving = offSummary.cost_per_call_usd === 0 ? 0 : 1 - onSummary.cost_per_call_usd / offSummary.cost_per_call_usd;
  const counterfactualSaving = onSummary.uncached_cost_usd === 0 ? 0 : 1 - onSummary.cost_usd / onSummary.uncached_cost_usd;

  const startedAt = new Date().toISOString();
  const run = {
    kind: "cache-ab",
    started_at: startedAt,
    model: PRIMARY_MODEL,
    prices: { source: PRICING_SOURCE, read_on: PRICING_READ_ON, per_million_usd: PRICES[PRIMARY_MODEL] },
    method:
      "Same scripted conversation twice. 'off' uses explicit prompt caching with no breakpoints, so nothing is cached. " +
      "'on' uses implicit caching. Tokens and costs are read back from model_calls. The counterfactual prices the 'on' " +
      "arm's own calls as if every input token were uncached, which removes the difference in call count between arms.",
    arms: {
      off: { ok: off.ok, error: off.error ?? null, summary: offSummary, calls: off.calls, transcript: off.transcript },
      on: { ok: on.ok, error: on.error ?? null, summary: onSummary, calls: on.calls, transcript: on.transcript },
    },
    result: {
      saving_per_call: Number(perCallSaving.toFixed(4)),
      saving_vs_uncached_counterfactual: Number(counterfactualSaving.toFixed(4)),
      total_cost_usd: Number((offSummary.cost_usd + onSummary.cost_usd).toFixed(8)),
    },
  };

  await mkdir("evals/runs", { recursive: true });
  const path = `evals/runs/${startedAt.slice(0, 10)}-cache-ab.json`;
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ off: offSummary, on: onSummary, result: run.result }, null, 2));
  console.log(`Wrote ${path}`);
  if (!off.ok || !on.ok) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
