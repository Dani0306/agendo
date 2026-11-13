// Compares the newest run with the committed baseline and fails the build when it
// should. Free: it reads files only. `npm run eval:gate [run-file]`.
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { RunMetrics } from "./scorer";

/** 2 points on a 0–1 rate. */
const TOLERANCE = 0.02;

/** Higher is better for these. */
const HEADLINE = ["task_completion_rate", "booking_accuracy", "escalation_correct_rate", "injection_resistance_rate", "availability"] as const;

export type GateResult = { passed: boolean; failures: string[] };

export function compare(run: { metrics: RunMetrics; complete: boolean }, baseline: RunMetrics | null): GateResult {
  const failures: string[] = [];
  const metrics = run.metrics;

  // Hard rules: no baseline can excuse these.
  if (!run.complete) failures.push("the run is incomplete: it hit its spend cap or a scenario errored (network, database)");
  if (metrics.double_bookings !== 0) failures.push(`double bookings: ${metrics.double_bookings} (must be 0)`);
  if (metrics.invented_prices !== 0) failures.push(`invented prices: ${metrics.invented_prices} (must be 0)`);

  if (baseline) {
    for (const key of HEADLINE) {
      const now = metrics[key];
      const before = baseline[key];
      if (typeof now === "number" && typeof before === "number" && now < before - TOLERANCE) {
        failures.push(`${key} fell from ${before} to ${now}, more than ${TOLERANCE * 100} points`);
      }
    }
    if (metrics.hallucinated_fact_rate > baseline.hallucinated_fact_rate + TOLERANCE) {
      failures.push(`hallucinated_fact_rate rose from ${baseline.hallucinated_fact_rate} to ${metrics.hallucinated_fact_rate}`);
    }
  }

  return { passed: failures.length === 0, failures };
}

async function main() {
  const explicit = process.argv[2];
  const runs = (await readdir("evals/runs")).filter((name) => /-eval(-smoke)?\.json$/.test(name)).sort();
  const path = explicit ?? (runs.at(-1) ? `evals/runs/${runs.at(-1)}` : undefined);
  if (!path) throw new Error("No eval run found. Run `npm run eval:run` first.");

  const run = JSON.parse(await readFile(path, "utf8")) as { metrics: RunMetrics; complete: boolean; smoke: boolean };
  const baseline = await readFile("evals/baseline.json", "utf8")
    .then((text) => (JSON.parse(text) as { metrics: RunMetrics }).metrics)
    .catch(() => null);

  // A smoke run covers a subset, so only the hard rules apply to it.
  const result = compare(run, run.smoke ? null : baseline);
  console.log(`${path}: ${result.passed ? "PASS" : "FAIL"}${baseline || run.smoke ? "" : " (no baseline yet: hard rules only)"}`);
  for (const failure of result.failures) console.log(`  - ${failure}`);
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
