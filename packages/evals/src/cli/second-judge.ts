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
  stratifiedSecondJudgeSample,
  validateJudgments,
  verdictAgreement,
  type AgreementStat,
  type AnswerRecord,
  type JudgeItem,
  type Judgment,
} from '../answers.ts';
import { errorMessage } from '../io.ts';
import { parseJsonl, toJsonl } from '../schema.ts';

/** Fixed seed for the second-judge sample (S6). */
const SECOND_JUDGE_SEED = 20261126;
/** Fixed seed for the passing stratum of the stratified second-judge sample (S6). */
const STRATIFIED_SEED = 20261127;

interface SampleFile {
  readonly seed: number;
  readonly ids: string[];
  /** Stratified design: every first-judge failure plus a seeded sample of passing items. */
  readonly strata?: { readonly failures: string[]; readonly correct: string[] };
}

const USAGE =
  'Usage: pnpm eval:second-judge <run.json> [--n 30] [--name opus] [--batch-size 10]   (writes <run>-judge-<name>/ batches)\n' +
  '       pnpm eval:second-judge <run.json> --stratified [--n-correct 20] --name opus-strat   (all first-judge failures + seeded passing items)\n' +
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
      stratified: { type: 'boolean', default: false },
      'n-correct': { type: 'string', default: '20' },
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
    let sample: JudgeItem[];
    let meta: SampleFile;
    if (values.stratified) {
      const nCorrect = Number(values['n-correct']);
      if (!Number.isInteger(nCorrect) || nCorrect < 0) throw new Error('--n-correct must be a non-negative integer.');
      const strata = stratifiedSecondJudgeSample(all, await readJudgments(`${base}-judgments`, all), nCorrect, STRATIFIED_SEED);
      const ids = new Set([...strata.failures, ...strata.correct]);
      // Original run order, so the batches mix both strata and the judge cannot tell them apart.
      sample = all.filter((i) => ids.has(i.id));
      meta = { seed: STRATIFIED_SEED, ids: sample.map((i) => i.id), strata };
    } else {
      sample = sampleForSecondJudge(all, n, SECOND_JUDGE_SEED);
      meta = { seed: SECOND_JUDGE_SEED, ids: sample.map((i) => i.id) };
    }
    await mkdir(batchDir, { recursive: true });
    await mkdir(`${base}-judgments-${name}`, { recursive: true });
    for (const [i, batch] of batches(sample, size).entries()) {
      await writeFile(join(batchDir, `batch-${String(i + 1).padStart(2, '0')}.jsonl`), toJsonl(batch), 'utf8');
    }
    await writeFile(sampleFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    const strataNote = meta.strata ? ` (${meta.strata.failures.length} first-judge failures + ${meta.strata.correct.length} passing)` : '';
    console.log(`Second-judge sample: ${sample.length} of ${all.length} items${strataNote} (seed ${meta.seed}) in ${batchDir}; judgments go to ${base}-judgments-${name}/`);
    return;
  }

  const sample = JSON.parse(await readFile(sampleFile, 'utf8')) as SampleFile;
  const ids = new Set(sample.ids);
  const items = all.filter((i) => ids.has(i.id));
  const first = (await readJudgments(`${base}-judgments`, all)).filter((j) => ids.has(j.id));
  const second = await readJudgments(`${base}-judgments-${name}`, items);
  const firstModels = [...new Set(first.map((j) => j.judge_model))];
  const secondModels = [...new Set(second.map((j) => j.judge_model))];
  const outBase = name === 'opus' ? `${base}-judge-agreement` : `${base}-judge-agreement-${name}`;

  const section = (title: string, subset: readonly JudgeItem[]): { lines: string[]; data: unknown } => {
    const subIds = subset.map((i) => i.id);
    const fields = judgeAgreement(subset, first, second);
    const verdict = verdictAgreement(subIds, first, second);
    return {
      data: { n: subset.length, verdict, fields },
      lines: [
        `## ${title} (${subset.length} items; answered by the bot: ${fields.answered})`,
        '',
        `- Overall verdict (failure vs pass): ${stat(verdict)}`,
        `- correct (answered items): ${stat(fields.correct)}`,
        `- unsupported_claims > 0 (answered items): ${stat(fields.unsupportedAny)}`,
        `- unsupported_claims, same count: ${ci(fields.unsupportedExact)}`,
        `- appropriate (non-answered items): ${stat(fields.appropriate)}`,
        '',
        ...(fields.disagreements.length === 0
          ? ['Disagreements: none.']
          : ['| id | field | first judge | second judge |', '| --- | --- | --- | --- |', ...fields.disagreements.map((d) => `| ${d.id} | ${d.field} | ${String(d.first)} | ${String(d.second)} |`)]),
        '',
      ],
    };
  };

  const sections: { title: string; subset: JudgeItem[] }[] = sample.strata
    ? [
        { title: 'Stratum: first-judge failures', subset: items.filter((i) => sample.strata?.failures.includes(i.id)) },
        { title: 'Stratum: first-judge passing items', subset: items.filter((i) => sample.strata?.correct.includes(i.id)) },
        { title: 'Pooled (stratified sample, not representative of the run)', subset: items },
      ]
    : [{ title: 'Sample', subset: items }];
  const built = sections.map((x) => ({ title: x.title, ...section(x.title, x.subset) }));
  await writeFile(
    `${outBase}.json`,
    `${JSON.stringify({ run: arg, seed: sample.seed, design: sample.strata ? 'stratified' : 'random', firstJudge: firstModels, secondJudge: secondModels, sections: built.map((b) => ({ title: b.title, ...(b.data as object) })) }, null, 2)}\n`,
    'utf8',
  );
  const md = [
    `# Judge agreement: ${arg.replace(/\\/g, '/')}${name === 'opus' ? '' : ` (${name})`}`,
    '',
    `- Design: ${sample.strata ? `stratified: all ${sample.strata.failures.length} first-judge failures + ${sample.strata.correct.length} seeded passing items` : 'random'}; seed ${sample.seed}.`,
    `- First judge: ${firstModels.join(', ')}; second judge: ${secondModels.join(', ')}; same rubric (v1), isolated${sample.strata ? ', blind to the strata' : ''}.`,
    '- A failure is: correct = false, or unsupported_claims > 0, or appropriate = false.',
    '',
    ...built.flatMap((b) => b.lines),
  ].join('\n');
  await writeFile(`${outBase}.md`, `${md}\n`, 'utf8');
  console.log(md);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
