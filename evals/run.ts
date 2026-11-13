// Runs the eval suite and writes a run file. Costs money, so it prints an estimate,
// takes a spend cap and stops starting scenarios once the cap is reached.
//   npm run eval:run -- --max-usd 0.50 [--smoke] [--only <id>] [--concurrency 4]
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PRICES, PRICING_READ_ON, PRICING_SOURCE } from "@/lib/cost/pricing";
import { FALLBACK_MODEL, PRIMARY_MODEL } from "@/lib/models";
import { runScenario } from "./harness";
import { type Scenario, ScenarioSchema } from "./schema";
import { type ScenarioRecord, scoreScenario, summarize } from "./scorer";

/** From the first smoke run; replaced as runs accumulate. */
const ESTIMATED_USD_PER_SCENARIO = 0.005;

async function loadScenarios(): Promise<Scenario[]> {
  const files = (await readdir("evals/scenarios")).filter((name) => name.endsWith(".json")).sort();
  const scenarios = await Promise.all(
    files.map(async (name) => ScenarioSchema.parse(JSON.parse(await readFile(`evals/scenarios/${name}`, "utf8")))),
  );
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
  }
  return scenarios;
}

const cost = (record: ScenarioRecord) => record.calls.reduce((sum, call) => sum + call.cost_usd, 0);

async function main() {
  const { values } = parseArgs({
    options: {
      "max-usd": { type: "string" },
      smoke: { type: "boolean", default: false },
      only: { type: "string" },
      concurrency: { type: "string", default: "4" },
    },
  });
  if (!values["max-usd"]) throw new Error("--max-usd is required");
  const maxUsd = Number(values["max-usd"]);
  const concurrency = Math.max(1, Number(values.concurrency));

  const all = await loadScenarios();
  const selected = all.filter(
    (scenario) => (!values.smoke || scenario.tags.includes("smoke")) && (!values.only || scenario.id === values.only),
  );
  console.log(
    `${selected.length} scenarios, ${concurrency} at a time. Estimated $${(selected.length * ESTIMATED_USD_PER_SCENARIO).toFixed(3)}, cap $${maxUsd.toFixed(2)}.`,
  );

  const records: ScenarioRecord[] = [];
  let spent = 0;
  let stopped = false;
  let next = 0;

  const worker = async () => {
    while (next < selected.length) {
      if (spent >= maxUsd) {
        stopped = true;
        return;
      }
      const scenario = selected[next]!;
      next += 1;
      // One scenario's failure is recorded as its error; it never stops the run.
      const record = await runScenario(scenario).catch(
        (error: unknown): ScenarioRecord => ({
          scenario,
          transcript: [],
          bookings: [],
          calls: [],
          prices: [],
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        }),
      );
      spent += cost(record);
      records.push(record);
      const score = scoreScenario(record);
      console.log(
        `${score.completed ? "PASS" : "FAIL"} ${scenario.id.padEnd(30)} ${score.turns} turns, $${cost(record).toFixed(4)}` +
          `${record.error ? `, error: ${record.error}` : ""}${score.invented_prices ? `, invented prices ${score.invented_price_examples.join("/")}` : ""}`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  records.sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
  const scores = records.map(scoreScenario);
  const metrics = summarize(records, scores);
  // A scenario that errored (network, database) measured nothing, so the run is incomplete.
  const scenarioErrors = records.filter((record) => record.error).length;
  const complete = !stopped && records.length === selected.length && scenarioErrors === 0;

  const startedAt = new Date().toISOString();
  const run = {
    kind: "eval",
    smoke: values.smoke,
    started_at: startedAt,
    complete,
    config: {
      models: { agent_chain: [PRIMARY_MODEL, FALLBACK_MODEL], simulated_customer: PRIMARY_MODEL },
      prices: { source: PRICING_SOURCE, read_on: PRICING_READ_ON, per_million_usd: { [PRIMARY_MODEL]: PRICES[PRIMARY_MODEL], [FALLBACK_MODEL]: PRICES[FALLBACK_MODEL] } },
      max_usd: maxUsd,
      concurrency,
      scenarios: selected.map((scenario) => scenario.id),
    },
    total_cost_usd: Number(spent.toFixed(6)),
    scenario_errors: scenarioErrors,
    metrics,
    scores,
    records: records.map((record) => ({ id: record.scenario.id, error: record.error ?? null, transcript: record.transcript, bookings: record.bookings })),
  };

  await mkdir("evals/runs", { recursive: true });
  const path = `evals/runs/${startedAt.slice(0, 19).replace(/:/g, "")}-eval${values.smoke ? "-smoke" : ""}.json`;
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(metrics, null, 2));
  console.log(`Total $${spent.toFixed(4)}${complete ? "" : " (stopped at the cap)"}. Wrote ${path}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
