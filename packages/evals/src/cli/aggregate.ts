import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  aggregate,
  ci,
  codeMetricsMarkdown,
  computeCodeMetrics,
  judgeItemFromRecord,
  liveSummary,
  pct,
  targetsMarkdown,
  validateJudgments,
  type AnswerRecord,
  type JudgeItem,
  type LiveSummary,
} from '../answers.ts';
import { errorMessage } from '../io.ts';
import { parseJsonl } from '../schema.ts';

const USAGE =
  'Usage: pnpm eval:aggregate evals/runs/<date>-answers[-label].json [--live <realistic live run>.json] [--stress <burst live run>.json]';

/** Time and availability recomputed from a live run's records (works for runs recorded before S5c too). */
async function readLive(path: string): Promise<LiveSummary> {
  const run = JSON.parse(await readFile(resolve(path), 'utf8')) as { mode?: string; records?: AnswerRecord[] };
  if (run.mode !== 'live') throw new Error(`${path} is not a live-mode run.`);
  return liveSummary(computeCodeMetrics(run.records ?? []));
}

interface RunFile {
  kind: 'answers' | 'external';
  set: string;
  label: string;
  createdAt: string;
  records?: AnswerRecord[];
  items?: JudgeItem[];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { live: { type: 'string' }, stress: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  const arg = positionals[0];
  if (!arg || values.help) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const runPath = resolve(arg);
  const base = runPath.replace(/\.json$/, '');
  const run = JSON.parse(await readFile(runPath, 'utf8')) as RunFile;
  if (run.set !== 'dev' && run.set !== 'test') throw new Error(`Unknown set "${run.set}" in ${arg}.`);

  const items = run.kind === 'external' ? (run.items ?? []) : (run.records ?? []).map(judgeItemFromRecord);
  const dir = `${base}-judgments`;
  if (!existsSync(dir)) throw new Error(`Missing ${dir}. Judge the batches first.`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const raw = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).flatMap((text) => parseJsonl(text));
  const { judgments, errors } = validateJudgments(items, raw);
  if (errors.length > 0) throw new Error(`Invalid judgments:\n- ${errors.join('\n- ')}`);

  const code = run.kind === 'answers' ? computeCodeMetrics(run.records ?? []) : null;
  const live = values.live ? await readLive(values.live) : null;
  const stress = values.stress ? await readLive(values.stress) : null;
  const metrics = aggregate(items, judgments, code, live, stress);
  const judgeModels = [...new Set(judgments.map((j) => j.judge_model))];

  await writeFile(`${base}-aggregate.json`, `${JSON.stringify({ run: arg, live: values.live ?? null, stress: values.stress ?? null, judgeModels, code, ...metrics }, null, 2)}\n`, 'utf8');
  const j = metrics.judge;
  const md = [
    `# Aggregate: ${arg.replace(/\\/g, '/')}`,
    '',
    `- Kind: ${run.kind}; judged items: ${judgments.length} (${files.length} batch files); judge: ${judgeModels.join(', ')}.`,
    '',
    '## Targets',
    '',
    targetsMarkdown(metrics.targets),
    '## Judge',
    '',
    `- Correct among answered: ${ci(j.correctOnAnswered)}; unsupported claims total: ${j.unsupportedClaimsTotal}; completeness mean: ${j.completeMean.toFixed(2)} / 2.`,
    `- Appropriate among non-answered: ${ci(j.appropriateOnNonAnswered)}.`,
    ...Object.entries(j.appropriateByExpected).map(([b, p]) => `  - expected ${b}: ${p.n === 0 ? 'n/a' : ci(p)}`),
    '',
    ...(code ? ['## Code metrics', '', codeMetricsMarkdown(code)] : []),
  ].join('\n');
  await writeFile(`${base}-aggregate.md`, `${md}\n`, 'utf8');

  for (const t of metrics.targets) {
    const value = typeof t.value === 'number' ? `${(t.value / 1000).toFixed(2)} s` : `${pct(t.value.value)} [${pct(t.value.lo)}–${pct(t.value.hi)}]`;
    console.log(`${t.met === null ? 'INFO' : t.met ? 'MET ' : 'MISS'} ${t.label}: ${value} (target ${t.target})`);
  }
  console.log(`Wrote ${base}-aggregate.json and .md`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
