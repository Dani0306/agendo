// One scripted conversation through the real core and the real model. Costs money, so
// it stops at a cap and is not part of `npm test`.
import { runScriptedConversation } from "./lib/scripted-conversation";

const MAX_USD = 0.05;

async function main() {
  const result = await runScriptedConversation({ promptCache: "implicit", maxUsd: MAX_USD });
  const usd = result.calls.reduce((sum, call) => sum + Number(call.cost_usd), 0);
  const latencies = result.calls.map((call) => call.latency_ms).sort((a, b) => a - b);
  const total = (field: "input_tokens" | "cache_write_tokens" | "cache_read_tokens" | "output_tokens") =>
    result.calls.reduce((sum, call) => sum + call[field], 0);

  console.log(
    `\n${result.calls.length} model calls, $${usd.toFixed(6)}, median latency ${latencies[Math.floor(latencies.length / 2)] ?? 0} ms, ` +
      `input ${total("input_tokens")}, cache write ${total("cache_write_tokens")}, cache read ${total("cache_read_tokens")}, output ${total("output_tokens")}`,
  );
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
