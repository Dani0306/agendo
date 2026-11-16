// Regenerates the README blocks that come from run files. README numbers are never typed
// by hand: this reads the newest chaos and full eval run files and rewrites the blocks
// between their <!-- name:start --> and <!-- name:end --> markers. Free: it reads files only.
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

type EvalRun = {
  started_at: string;
  complete: boolean;
  total_cost_usd: number;
  metrics: Record<string, number | null>;
  scores: { id: string; completed: boolean }[];
};

const pct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${Math.round(value * 1000) / 10}%`);

function evalBlock(run: EvalRun, file: string): string {
  const m = run.metrics;
  const failed = run.scores.filter((score) => !score.completed).map((score) => `\`${score.id}\``);
  return [
    `**Eval suite** — ${m.scenarios} simulated customers, run ${run.started_at.slice(0, 10)} ([run file](${file}))${run.complete ? "" : ", stopped at its spend cap"}.`,
    "",
    "| Metric | Result |",
    "| --- | --- |",
    `| Task completion (judged from database rows) | ${pct(m.task_completion_rate)} |`,
    `| Booking accuracy | ${pct(m.booking_accuracy)} |`,
    `| **Double bookings** | **${m.double_bookings}** |`,
    `| **Invented prices** | **${m.invented_prices}** |`,
    `| Hallucinated-fact rate | ${pct(m.hallucinated_fact_rate)} |`,
    `| Correct escalation to a person | ${pct(m.escalation_correct_rate)} |`,
    `| Injection resistance | ${pct(m.injection_resistance_rate)} |`,
    `| Useful replies | ${pct(m.availability)} |`,
    `| Replies the output check replaced with the menu | ${m.output_check_caught} |`,
    `| Turns per conversation | ${m.avg_turns} |`,
    `| Cost per conversation (agent + simulated customer) | $${Number(m.cost_per_conversation_usd).toFixed(5)} |`,
    `| Prompt tokens read from cache | ${pct(m.cache_hit_ratio)} |`,
    "",
    failed.length === 0 ? "Every scenario completed." : `Not completed: ${failed.join(", ")}.`,
    "",
    `Total cost of the run: $${run.total_cost_usd.toFixed(4)}.`,
  ].join("\n");
}

async function newest(suffix: string): Promise<string | undefined> {
  return (await readdir(RUNS)).filter((name) => name.endsWith(suffix)).sort().at(-1);
}

async function main() {
  let readme = await readFile(README, "utf8");

  const chaos = await newest("-chaos.json");
  if (chaos) {
    readme = replaceBlock(readme, "chaos", chaosBlock(JSON.parse(await readFile(`${RUNS}/${chaos}`, "utf8")) as ChaosRun, `${RUNS}/${chaos}`));
    console.log(`README chaos block written from ${RUNS}/${chaos}`);
  }

  // Full runs only: a smoke subset isn't the suite.
  const evals = await newest("-eval.json");
  if (evals && readme.includes("<!-- evals:start -->")) {
    readme = replaceBlock(readme, "evals", evalBlock(JSON.parse(await readFile(`${RUNS}/${evals}`, "utf8")) as EvalRun, `${RUNS}/${evals}`));
    console.log(`README evals block written from ${RUNS}/${evals}`);
  }

  await writeFile(README, readme, "utf8");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
