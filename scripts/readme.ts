// Regenerates the README blocks that come from run files. README numbers are never typed
// by hand: this reads the newest evals/runs/*-chaos.json and rewrites the block between
// <!-- chaos:start --> and <!-- chaos:end -->. Free: it reads files only.
import { readdir, readFile, writeFile } from "node:fs/promises";

const README = "README.md";
const RUNS = "evals/runs";

type ChaosRun = {
  started_at: string;
  passed: boolean;
  models: { primary: string; fallback: string };
  checks: Record<string, boolean>;
  availability_under_failure: { a_revoked_key: number; b_primary_missing: number; c_recovery: number; all_measured_turns: number };
  scenario_a_and_c: { turns: { said: string; phase: string; degraded: string | null; served_by: string | null; model_calls: number; latency_ms: number; useful: boolean }[] };
  scenario_b: { ok: boolean; model_calls: number; failed_calls_on_missing_model: number; fallback_calls: number; fallback_cost_per_conversation_usd: number };
  cost_usd: { total: number };
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

const CHECK_LABELS: Record<string, string> = {
  a_every_turn_useful: "Every turn got a useful reply while the key was revoked",
  a_breakers_skip_dead_models: "Once the breakers opened, a turn made no model calls",
  a_menu_answered_without_model: "A menu choice was answered with no model",
  b_booking_completed_on_fallback: "A full booking ran on the fallback when the primary model was missing",
  c_primary_serves_again: "After the cool-down the primary served again",
};

function chaosBlock(run: ChaosRun, file: string): string {
  const rows = run.scenario_a_and_c.turns
    .filter((turn) => turn.phase !== "consent")
    .map((turn) => {
      const reply = turn.degraded ? `${turn.degraded}` : `answer (${turn.served_by})`;
      return `| ${turn.phase} | ${turn.said} | ${reply} | ${turn.model_calls} | ${turn.latency_ms} ms |`;
    });
  return [
    `**Chaos test** — ${run.passed ? "passed" : "FAILED"}, run ${run.started_at.slice(0, 10)} ([run file](${file})).`,
    "",
    `Primary \`${run.models.primary}\`, fallback \`${run.models.fallback}\`, then a numbered menu built from the clinic's own data.`,
    "",
    "| Scenario | Availability under failure |",
    "| --- | --- |",
    `| A. Key revoked mid-conversation (real 401s) | ${percent(run.availability_under_failure.a_revoked_key)} |`,
    `| B. Primary model missing (real 404s) | ${percent(run.availability_under_failure.b_primary_missing)} |`,
    `| C. Key restored, breaker probe | ${percent(run.availability_under_failure.c_recovery)} |`,
    "",
    "| Phase | Customer wrote | Reply | Model calls | Latency |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Scenario B: ${run.scenario_b.failed_calls_on_missing_model} calls to the missing model before its breaker opened, ` +
      `${run.scenario_b.fallback_calls} served by the fallback, $${run.scenario_b.fallback_cost_per_conversation_usd.toFixed(4)} for the whole booking conversation.`,
    "",
    ...Object.entries(run.checks).map(([key, ok]) => `- ${ok ? "✅" : "❌"} ${CHECK_LABELS[key] ?? key}`),
    "",
    `Total cost of the run: $${run.cost_usd.total.toFixed(4)}.`,
  ].join("\n");
}

function replaceBlock(readme: string, name: string, body: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from === -1 || to === -1 || to < from) throw new Error(`README.md has no ${name} markers`);
  return `${readme.slice(0, from + start.length)}\n${body}\n${readme.slice(to)}`;
}

async function main() {
  const files = (await readdir(RUNS)).filter((name) => name.endsWith("-chaos.json")).sort();
  const newest = files.at(-1);
  if (!newest) throw new Error("No chaos run in evals/runs. Run `npm run chaos` first.");

  const run = JSON.parse(await readFile(`${RUNS}/${newest}`, "utf8")) as ChaosRun;
  const readme = await readFile(README, "utf8");
  await writeFile(README, replaceBlock(readme, "chaos", chaosBlock(run, `${RUNS}/${newest}`)), "utf8");
  console.log(`README chaos block written from ${RUNS}/${newest}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
