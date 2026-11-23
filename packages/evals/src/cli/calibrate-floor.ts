import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { calibrateFloor, DEFAULT_FLOOR_RULE, floorSensitivity, floorSensitivityMarkdown, SENSITIVITY_FLOORS, type SimilarityRow } from '../floor.ts';
import { errorMessage, RUNS_DIR } from '../io.ts';
import { assertSetAllowed } from '../retrieval.ts';

const USAGE = 'Usage: pnpm eval:calibrate-floor --set dev [--run evals/runs/<date>-vector.json]';

/** Latest recorded vector retrieval run (no API, no DB). */
async function latestVectorRun(): Promise<string> {
  const files = (await readdir(RUNS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}-vector(-\d+)?\.json$/.test(f)).sort();
  const last = files.at(-1);
  if (!last) throw new Error('No vector run in evals/runs. Run "pnpm eval:retrieval --set dev --mode vector" first.');
  return join(RUNS_DIR, last);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { set: { type: 'string' }, run: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help || !values.set) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  assertSetAllowed(values.set);
  const runFile = values.run ?? (await latestVectorRun());
  const run = JSON.parse(await readFile(runFile, 'utf8')) as { set: string; perQuestion: SimilarityRow[] };
  if (run.set !== 'dev') throw new Error(`${runFile} is not a dev run.`);

  const rows = run.perQuestion;
  const { floor, bindingConstraint } = calibrateFloor(rows, DEFAULT_FLOOR_RULE);
  const sensitivity = floorSensitivity(rows, [...SENSITIVITY_FLOORS, floor]);
  const chosen = sensitivity.find((r) => r.floor === floor);
  const table = floorSensitivityMarkdown(sensitivity, floor);

  console.log(`Run: ${runFile}`);
  console.log(
    `Rule: highest floor with ≤${DEFAULT_FLOOR_RULE.maxAnswerBelow} answer and 0 ${DEFAULT_FLOOR_RULE.protectedBehaviors.join('/')} below ` +
      `(rounded down to ${DEFAULT_FLOOR_RULE.decimals} decimals).`,
  );
  console.log(`FLOOR = ${floor.toFixed(3)} (binding constraint: ${bindingConstraint})`);
  if (chosen) {
    console.log(
      `Below the floor: abstain ${chosen.abstainCaught}/${chosen.abstainTotal}, answer ${chosen.answerLost}/${chosen.answerTotal}, ` +
        `handoff ${chosen.handoffBelow}, decline ${chosen.declineBelow}.`,
    );
  }
  console.log(`\n${table}`);

  const out = join(RUNS_DIR, `${new Date().toISOString().slice(0, 10)}-floor-calibration.md`);
  await writeFile(
    out,
    `# FLOOR calibration (dev)\n\n- Source run: \`${runFile.replace(/\\/g, '/').replace(/^.*evals\/runs\//, 'evals/runs/')}\`\n` +
      `- Rule: highest floor with at most ${DEFAULT_FLOOR_RULE.maxAnswerBelow} answer question and no handoff/decline question below it.\n` +
      `- FLOOR: **${floor.toFixed(3)}** (binding constraint: ${bindingConstraint}).\n\n## Sensitivity\n\n${table}`,
    'utf8',
  );
  console.log(`Wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
