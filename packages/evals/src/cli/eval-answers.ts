import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { answerQuestion, generationLimitDefaults, maxSimilarity, planEmbeddings, PROMPT_VERSION, type AppConfig } from '@groundline/core';
import { PgDb } from '@groundline/db/node';
import { createAnswerRuntime } from '../answer-runtime.ts';
import {
  batches,
  codeMetricsMarkdown,
  computeCodeMetrics,
  judgeItemFromRecord,
  parseExternalAnswers,
  pct,
  toAnswerRecord,
  type AnswerRecord,
  type JudgeItem,
} from '../answers.ts';
import { cacheStoreFor, CHUNKS_FILE, DEV_FILE, errorMessage, loadConfig, REPO_ROOT, RUNS_DIR } from '../io.ts';
import { assertSetAllowed } from '../retrieval.ts';
import { parseJsonl, toJsonl, type EvalQuestion } from '../schema.ts';

const USAGE = 'Usage: pnpm eval:answers --set dev [--label name] [--dry-run] [--batch-size 10] | --set dev --external answers.csv [--label name]';

async function freeBase(base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; existsSync(`${candidate}.json`); i++) candidate = `${base}-${i}`;
  return Promise.resolve(candidate);
}

const rel = (p: string): string => p.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');

async function writeJudgeBatches(base: string, items: readonly JudgeItem[], size: number): Promise<string> {
  const dir = `${base}-judge`;
  await mkdir(dir, { recursive: true });
  await mkdir(`${base}-judgments`, { recursive: true });
  for (const [i, batch] of batches(items, size).entries()) {
    await writeFile(join(dir, `batch-${String(i + 1).padStart(2, '0')}.jsonl`), toJsonl(batch), 'utf8');
  }
  return dir;
}

function configSummary(config: AppConfig): Record<string, unknown> {
  const g = config.generation;
  return {
    generationModel: g.model,
    temperature: g.temperature,
    maxOutputTokens: g.maxOutputTokens,
    thinkingLevel: g.thinkingLevel ?? 'OFF',
    schemaField: g.schemaField,
    generationLimits: g.limits,
    embeddingModel: config.embedding.model,
    retrievalMode: config.answer.retrievalMode,
    candidates: config.answer.candidates,
    sources: config.answer.sources,
    floor: config.answer.floor,
  };
}

async function runExternal(questions: readonly EvalQuestion[], csvPath: string, label: string, batchSize: number): Promise<void> {
  const answers = parseExternalAnswers(await readFile(resolve(csvPath), 'utf8'), new Set(questions.map((q) => q.id)));
  if (!existsSync(CHUNKS_FILE)) throw new Error(`Missing ${CHUNKS_FILE}. Run "pnpm corpus:export --source plausible" first.`);
  const chunks = new Map(
    parseJsonl(await readFile(CHUNKS_FILE, 'utf8')).map((row) => {
      const r = row as { id: string; url: string; doc_title: string; content: string };
      return [r.id, r] as const;
    }),
  );
  const items: JudgeItem[] = questions
    .filter((q) => answers.has(q.id))
    .map((q) => ({
      id: q.id,
      mode: 'external',
      question: q.question,
      expected_behavior: q.expected_behavior,
      reference_answer: q.reference_answer,
      key_facts: q.key_facts,
      answer: answers.get(q.id) ?? '',
      evidence: q.source_chunk_ids.flatMap((id) => {
        const c = chunks.get(id);
        return c ? [{ url: c.url, title: c.doc_title, text: c.content }] : [];
      }),
    }));
  await mkdir(RUNS_DIR, { recursive: true });
  const createdAt = new Date().toISOString();
  const base = await freeBase(join(RUNS_DIR, `${createdAt.slice(0, 10)}-external${label ? `-${label}` : ''}`));
  await writeFile(`${base}.json`, `${JSON.stringify({ kind: 'external', set: 'dev', label, createdAt, source: csvPath, items }, null, 2)}\n`, 'utf8');
  const dir = await writeJudgeBatches(base, items, batchSize);
  console.log(`External answers: ${items.length} of ${questions.length} dev questions. No API calls.`);
  console.log(`Run: ${rel(base)}.json | judge batches: ${rel(dir)}/ | judgments go to ${rel(base)}-judgments/`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      set: { type: 'string' },
      label: { type: 'string', default: '' },
      external: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'batch-size': { type: 'string', default: '10' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help || !values.set) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  assertSetAllowed(values.set);
  const label = values.label.replace(/[^\w-]/g, '');
  const batchSize = Number(values['batch-size']);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) throw new Error('--batch-size must be an integer in [1, 50].');
  const questions = parseJsonl(await readFile(DEV_FILE, 'utf8')) as EvalQuestion[];

  if (values.external) {
    await runExternal(questions, values.external, label, batchSize);
    return;
  }

  const config = loadConfig();
  const missingLimits = generationLimitDefaults(config);
  if (missingLimits.length > 0) {
    console.warn(
      `Warning: ${missingLimits.join(', ')} not set in .env; using defaults ` +
        `${config.generation.limits.rpm} RPM / ${config.generation.limits.tpm} TPM / ${config.generation.limits.rpd} RPD. Check AI Studio for your real limits.`,
    );
  }
  const db = new PgDb(config.databaseUrl);
  try {
    const runtime = await createAnswerRuntime(config, db, { embedKind: 'embed_query_eval' });
    const { deps } = runtime;

    // Exact plan from cached embeddings: which questions the floor will short-circuit.
    const plan = await planEmbeddings(cacheStoreFor(db), config.embedding, questions.map((q) => q.question), 'RETRIEVAL_QUERY');
    let floorHits = 0;
    for (const [i, q] of questions.entries()) {
      const vector = plan.cached.get(plan.keys[i] ?? '');
      if (!vector) continue;
      const ranked = await deps.retrieve(q.question, vector, deps.config.candidates);
      if (maxSimilarity(ranked) < deps.config.floor) floorHits++;
    }
    const generationNeeded = questions.length - floorHits;
    const g = runtime.generationQuota;
    const e = runtime.embeddingQuota;
    console.log(`Dev set: ${questions.length} questions | model ${config.generation.model} | prompt ${PROMPT_VERSION} | floor ${deps.config.floor.toFixed(3)}`);
    console.log(`Floor will short-circuit ${floorHits} cached questions (${plan.misses.length} not cached yet).`);
    console.log(`Generation requests needed: up to ${generationNeeded} (+ retries on 429/5xx) | remaining today (${g.model}): ${g.remaining} of ${g.limit}`);
    console.log(`Embedding requests needed: ${plan.misses.length} | remaining today (${e.model}): ${e.remaining} of ${e.limit}`);
    if (values['dry-run']) {
      console.log('Dry run: no API calls made.');
      return;
    }
    if (generationNeeded > g.remaining) throw new Error(`Not enough generation quota: need ${generationNeeded}, ${g.remaining} remain today.`);
    if (plan.misses.length > e.remaining) throw new Error(`Not enough embedding quota: need ${plan.misses.length}, ${e.remaining} remain today.`);

    const records: AnswerRecord[] = [];
    let failure: unknown;
    for (const [i, q] of questions.entries()) {
      try {
        const result = await answerQuestion(deps, q.question);
        const record = toAnswerRecord(q, result);
        records.push(record);
        console.log(
          `[${String(i + 1).padStart(2)}/${questions.length}] ${q.id} ${q.expected_behavior.padEnd(7)} -> ${record.status.padEnd(12)}` +
            `${record.floor_hit ? ' (floor)' : ''} ${(record.latency.totalMs / 1000).toFixed(2)} s${record.error ? ` [${record.error}]` : ''}`,
        );
      } catch (error) {
        failure = error;
        console.error(`Stopped at ${q.id}: ${errorMessage(error)}`);
        break;
      }
    }

    await mkdir(RUNS_DIR, { recursive: true });
    const createdAt = new Date().toISOString();
    const base = await freeBase(join(RUNS_DIR, `${createdAt.slice(0, 10)}-answers${label ? `-${label}` : ''}`));
    const metrics = computeCodeMetrics(records);
    const partial = records.length < questions.length;
    const payload = { kind: 'answers', set: 'dev', label, createdAt, partial, promptVersion: PROMPT_VERSION, config: configSummary(config), metrics, records };
    await writeFile(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeFile(
      `${base}.md`,
      `# Answers run (dev${label ? `, ${label}` : ''})\n\n- Created: ${createdAt}\n- Prompt: ${PROMPT_VERSION}; model ${config.generation.model}${partial ? '\n- PARTIAL RUN' : ''}\n\n${codeMetricsMarkdown(metrics)}`,
      'utf8',
    );
    const dir = await writeJudgeBatches(base, records.map(judgeItemFromRecord), batchSize);
    console.log(`\nBehavior accuracy ${pct(metrics.behavior.overall.value)} | citation precision (doc) ${pct(metrics.citations.documentPrecision.value)} | p95 ${(metrics.latencyMs.all.p95 / 1000).toFixed(2)} s`);
    console.log(`Run: ${rel(base)}.json | judge batches: ${rel(dir)}/ | judgments go to ${rel(base)}-judgments/`);
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorMessage(failure));
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
