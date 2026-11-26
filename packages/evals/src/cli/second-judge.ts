import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  batches,
  ci,
  judgeAgreement,
  judgeItemFromRecord,
  sampleForSecondJudge,
  validateJudgments,
  type AgreementStat,
  type AnswerRecord,
  type JudgeItem,
  type Judgment,
} from '../answers.ts';
import { errorMessage } from '../io.ts';
import { parseJsonl, toJsonl } from '../schema.ts';

/** Fixed seed for the second-judge sample (S6). */
const SECOND_JUDGE_SEED = 20261126;

const USAGE =
  'Usage: pnpm eval:second-judge <run.json> [--n 30] [--name opus] [--batch-size 10]   (writes <run>-judge-<name>/ batches)\n' +
  '       pnpm eval:second-judge <run.json> --compare [--name opus]                 (agreement with <run>-judgments/)';

async function readJudgments(dir: string, items: readonly JudgeItem[]): Promise<Judgment[]> {
  if (!existsSync(dir)) throw new Error(`Missing ${dir}.`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const raw = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).flatMap((text) => parseJsonl(text));
  const { judgments, errors } = validateJudgments(items, raw);
  if (errors.length > 0) throw new Error(`Invalid judgments in ${dir}:\n- ${errors.join('\n- ')}`);
  return judgments;
}

const stat = (s: AgreementStat): string => `${ci(s.agreement)}; Cohen's kappa ${s.kappa === null ? 'n/a' : s.kappa.toFixed(2)}`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      n: { type: 'string', default: '30' },
      name: { type: 'string', default: 'opus' },
      'batch-size': { type: 'string', default: '10' },
      compare: { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const arg = positionals[0];
  if (!arg || values.help) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const name = values.name.replace(/[^\w-]/g, '');
  const runPath = resolve(arg);
  const base = runPath.replace(/\.json$/, '');
  const run = JSON.parse(await readFile(runPath, 'utf8')) as { kind?: string; records?: AnswerRecord[] };
  if (run.kind !== 'answers') throw new Error(`${arg} is not an answers run.`);
  const all = (run.records ?? []).map(judgeItemFromRecord);
  const batchDir = `${base}-judge-${name}`;
  const sampleFile = join(batchDir, 'sample.json');

  if (!values.compare) {
    const n = Number(values.n);
    const size = Number(values['batch-size']);
    if (!Number.isInteger(n) || n < 1 || n > all.length) throw new Error(`--n must be an integer in [1, ${all.length}].`);
    if (!Number.isInteger(size) || size < 1 || size > 50) throw new Error('--batch-size must be an integer in [1, 50].');
    if (existsSync(sampleFile)) throw new Error(`${sampleFile} exists: the second-judge sample is drawn once.`);
    const sample = sampleForSecondJudge(all, n, SECOND_JUDGE_SEED);
    await mkdir(batchDir, { recursive: true });
    await mkdir(`${base}-judgments-${name}`, { recursive: true });
    for (const [i, batch] of batches(sample, size).entries()) {
      await writeFile(join(batchDir, `batch-${String(i + 1).padStart(2, '0')}.jsonl`), toJsonl(batch), 'utf8');
    }
    await writeFile(sampleFile, `${JSON.stringify({ seed: SECOND_JUDGE_SEED, n, ids: sample.map((s) => s.id) }, null, 2)}\n`, 'utf8');
    console.log(`Second-judge sample: ${sample.length} of ${all.length} items (seed ${SECOND_JUDGE_SEED}) in ${batchDir}; judgments go to ${base}-judgments-${name}/`);
    return;
  }

  const sample = JSON.parse(await readFile(sampleFile, 'utf8')) as { seed: number; ids: string[] };
  const ids = new Set(sample.ids);
  const items = all.filter((i) => ids.has(i.id));
  const first = (await readJudgments(`${base}-judgments`, all)).filter((j) => ids.has(j.id));
  const second = await readJudgments(`${base}-judgments-${name}`, items);
  const result = judgeAgreement(items, first, second);
  const firstModels = [...new Set(first.map((j) => j.judge_model))];
  const secondModels = [...new Set(second.map((j) => j.judge_model))];
  await writeFile(`${base}-judge-agreement.json`, `${JSON.stringify({ run: arg, seed: sample.seed, firstJudge: firstModels, secondJudge: secondModels, ...result }, null, 2)}\n`, 'utf8');
  const md = [
    `# Judge agreement: ${arg.replace(/\\/g, '/')}`,
    '',
    `- Sample: ${result.n} items (seed ${sample.seed}); answered by the bot: ${result.answered}.`,
    `- First judge: ${firstModels.join(', ')}; second judge: ${secondModels.join(', ')}; same rubric (v1), isolated.`,
    '',
    `- correct (answered items): ${stat(result.correct)}`,
    `- unsupported_claims > 0 (answered items): ${stat(result.unsupportedAny)}`,
    `- unsupported_claims, same count: ${ci(result.unsupportedExact)}`,
    `- appropriate (non-answered items): ${stat(result.appropriate)}`,
    '',
    '## Disagreements',
    '',
    ...(result.disagreements.length === 0
      ? ['None.']
      : ['| id | field | first judge | second judge |', '| --- | --- | --- | --- |', ...result.disagreements.map((d) => `| ${d.id} | ${d.field} | ${String(d.first)} | ${String(d.second)} |`)]),
  ].join('\n');
  await writeFile(`${base}-judge-agreement.md`, `${md}\n`, 'utf8');
  console.log(md);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
