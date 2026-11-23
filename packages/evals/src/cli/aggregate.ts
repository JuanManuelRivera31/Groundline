import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  aggregate,
  ci,
  codeMetricsMarkdown,
  computeCodeMetrics,
  judgeItemFromRecord,
  pct,
  targetsMarkdown,
  validateJudgments,
  type AnswerRecord,
  type JudgeItem,
} from '../answers.ts';
import { errorMessage } from '../io.ts';
import { parseJsonl } from '../schema.ts';

const USAGE = 'Usage: pnpm eval:aggregate evals/runs/<date>-answers[-label].json';

interface RunFile {
  kind: 'answers' | 'external';
  set: string;
  label: string;
  createdAt: string;
  records?: AnswerRecord[];
  items?: JudgeItem[];
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === '--help') {
    console.log(USAGE);
    process.exitCode = arg ? 0 : 1;
    return;
  }
  const runPath = resolve(arg);
  const base = runPath.replace(/\.json$/, '');
  const run = JSON.parse(await readFile(runPath, 'utf8')) as RunFile;
  if (run.set !== 'dev') throw new Error('Only dev runs can be aggregated in this session.');

  const items = run.kind === 'external' ? (run.items ?? []) : (run.records ?? []).map(judgeItemFromRecord);
  const dir = `${base}-judgments`;
  if (!existsSync(dir)) throw new Error(`Missing ${dir}. Judge the batches first.`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const raw = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).flatMap((text) => parseJsonl(text));
  const { judgments, errors } = validateJudgments(items, raw);
  if (errors.length > 0) throw new Error(`Invalid judgments:\n- ${errors.join('\n- ')}`);

  const code = run.kind === 'answers' ? computeCodeMetrics(run.records ?? []) : null;
  const metrics = aggregate(items, judgments, code);
  const judgeModels = [...new Set(judgments.map((j) => j.judge_model))];

  await writeFile(`${base}-aggregate.json`, `${JSON.stringify({ run: arg, judgeModels, code, ...metrics }, null, 2)}\n`, 'utf8');
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
    console.log(`${t.met ? 'MET ' : 'MISS'} ${t.label}: ${value} (target ${t.target})`);
  }
  console.log(`Wrote ${base}-aggregate.json and .md`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
