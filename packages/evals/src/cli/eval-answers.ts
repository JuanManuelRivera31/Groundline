import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { answerQuestion, generationLimitDefaults, maxSimilarity, mulberry32, planEmbeddings, PROMPT_VERSION, shuffled, type AppConfig } from '@groundline/core';
import { PgDb } from '@groundline/db/node';
import { createAnswerRuntime } from '../answer-runtime.ts';
import {
  arrivalOffsets,
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

const SAMPLE_SEED = 20261123;
/** Fixed seed for the realistic live arrivals (--arrival-mean-ms). */
const ARRIVAL_SEED = 20261125;

const USAGE = 'Usage: pnpm eval:answers --set dev [--label name] [--prompt v3] [--model <eval primary>] [--live] [--sample N] [--arrival-mean-ms N] [--no-embed-cache] [--dry-run] [--batch-size 10] [--max-requests N] [--resume <run>.partial.jsonl] | --set dev --external answers.csv [--label name]';

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
    modelChain: g.models,
    liveBudgetMs: g.liveBudgetMs,
    hedgeAfterMs: g.hedgeAfterMs,
    promptVersion: config.answer.promptVersion,
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
      'max-requests': { type: 'string' },
      live: { type: 'boolean', default: false },
      sample: { type: 'string' },
      'arrival-mean-ms': { type: 'string' },
      'no-embed-cache': { type: 'boolean', default: false },
      prompt: { type: 'string' },
      model: { type: 'string' },
      resume: { type: 'string' },
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
  const allQuestions = parseJsonl(await readFile(DEV_FILE, 'utf8')) as EvalQuestion[];
  // --sample N: a seeded subset (kept in set order), e.g. for the live-latency sample.
  let questions = allQuestions;
  if (values.sample !== undefined) {
    const n = Number(values.sample);
    if (!Number.isInteger(n) || n < 1 || n > allQuestions.length) throw new Error(`--sample must be an integer in [1, ${allQuestions.length}].`);
    const picked = new Set(shuffled(allQuestions, mulberry32(SAMPLE_SEED)).slice(0, n).map((q) => q.id));
    questions = allQuestions.filter((q) => picked.has(q.id));
  }
  const mode = values.live ? 'live' : 'eval';
  // --arrival-mean-ms N: seeded exponential gaps between question starts (realistic live traffic, one question at a time).
  let arrivalMeanMs: number | null = null;
  if (values['arrival-mean-ms'] !== undefined) {
    arrivalMeanMs = Number(values['arrival-mean-ms']);
    if (!values.live) throw new Error('--arrival-mean-ms needs --live.');
    if (!Number.isInteger(arrivalMeanMs) || arrivalMeanMs < 1 || arrivalMeanMs > 600_000) throw new Error('--arrival-mean-ms must be an integer in [1, 600000].');
  }

  // --no-embed-cache: embed every question live (within the budget, full-text fallback) instead of reading the cache.
  const embedCache = !values['no-embed-cache'];
  if (!embedCache && !values.live) throw new Error('--no-embed-cache needs --live.');

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
    const runtime = await createAnswerRuntime(config, db, { embedKind: 'embed_query_eval', mode, promptVersion: values.prompt, primaryModel: values.model, embedCache });
    const { deps } = runtime;

    // Checkpoint: every record is appended to <base>.partial.jsonl as soon as it exists,
    // so an interrupted run resumes without spending quota twice.
    const resumeFile = values.resume ? resolve(values.resume) : undefined;
    if (resumeFile && !resumeFile.endsWith('.partial.jsonl')) throw new Error('--resume expects a <run>.partial.jsonl file.');
    const done: AnswerRecord[] = resumeFile ? (parseJsonl(await readFile(resumeFile, 'utf8')) as AnswerRecord[]) : [];
    const doneIds = new Set(done.map((r) => r.id));
    const todo = questions.filter((q) => !doneIds.has(q.id));
    if (resumeFile) console.log(`Resuming ${rel(resumeFile)}: ${done.length} questions already answered, ${todo.length} to go.`);

    // Exact plan from cached embeddings: which questions the floor will short-circuit.
    const plan = await planEmbeddings(cacheStoreFor(db), config.embedding, todo.map((q) => q.question), 'RETRIEVAL_QUERY');
    let floorHits = 0;
    for (const [i, q] of todo.entries()) {
      const vector = plan.cached.get(plan.keys[i] ?? '');
      if (!vector) continue;
      const ranked = await deps.retrieve(q.question, vector, deps.config.candidates);
      if (maxSimilarity(ranked) < deps.config.floor) floorHits++;
    }
    const generationNeeded = todo.length - floorHits;
    const g = runtime.generationQuota;
    const e = runtime.embeddingQuota;
    const promptVersion = deps.config.promptVersion ?? PROMPT_VERSION;
    const models = runtime.generationQuotas.map((q) => q.model).join(' → ');
    console.log(
      `Dev set: ${questions.length} questions | mode ${mode} | model${mode === 'live' ? ' chain' : ''} ${models} | prompt ${promptVersion} | floor ${deps.config.floor.toFixed(3)}` +
        (mode === 'live'
          ? ` | budget ${config.generation.liveBudgetMs} ms | hedge after ${config.generation.hedgeAfterMs} ms | embedding cache ${embedCache ? 'on' : 'off'}`
          : ''),
    );
    console.log(`Floor will short-circuit ${floorHits} cached questions (${plan.misses.length} not cached yet).`);
    console.log(`Generation requests needed: up to ${generationNeeded} (+ retries on 429/5xx${mode === 'live' ? ' / hops' : ''})`);
    for (const q of runtime.generationQuotas) console.log(`  remaining today (${q.model}): ${q.remaining} of ${q.limit}`);
    const embeddingNeeded = embedCache ? plan.misses.length : todo.length;
    console.log(`Embedding requests needed: ${embeddingNeeded} | remaining today (${e.model}): ${e.remaining} of ${e.limit}`);
    // Offsets for the whole sample (stable across resumes); a resumed run keeps the gaps between the remaining questions.
    const offsets = arrivalMeanMs === null ? null : arrivalOffsets(questions.length, arrivalMeanMs, mulberry32(ARRIVAL_SEED));
    if (offsets) console.log(`Arrivals: exponential gaps, mean ${arrivalMeanMs} ms, seed ${ARRIVAL_SEED}; about ${((offsets.at(-1) ?? 0) / 60_000).toFixed(1)} min of arrivals for the full sample.`);
    if (values['dry-run']) {
      console.log('Dry run: no API calls made.');
      return;
    }
    const maxRequests = values['max-requests'] === undefined ? Math.min(g.remaining, generationNeeded + 20) : Number(values['max-requests']);
    if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new Error('--max-requests must be a positive integer.');
    console.log(`Generation request cap for this run (incl. retries): ${maxRequests}`);
    // An explicit --max-requests (≤ remaining quota) allows a partial run that stops at the cap and resumes later.
    if (values['max-requests'] !== undefined) {
      if (maxRequests > g.remaining) throw new Error(`--max-requests ${maxRequests} exceeds the ${g.remaining} requests remaining today.`);
      if (generationNeeded > maxRequests) console.log(`Partial run: up to ${maxRequests} of ${generationNeeded} needed requests; resume after the quota resets.`);
    } else if (generationNeeded > g.remaining) {
      throw new Error(`Not enough generation quota: need ${generationNeeded}, ${g.remaining} remain today. Use --max-requests N to run until the cap.`);
    }
    if (embeddingNeeded > e.remaining) throw new Error(`Not enough embedding quota: need ${embeddingNeeded}, ${e.remaining} remain today.`);

    await mkdir(RUNS_DIR, { recursive: true });
    const base = resumeFile
      ? resumeFile.replace(/\.partial\.jsonl$/, '')
      : await freeBase(join(RUNS_DIR, `${new Date().toISOString().slice(0, 10)}-answers${label ? `-${label}` : ''}`));
    const partialFile = `${base}.partial.jsonl`;
    if (!resumeFile && existsSync(partialFile)) throw new Error(`${rel(partialFile)} exists; pass --resume ${rel(partialFile)}.`);
    console.log(`Checkpoint: ${rel(partialFile)}`);

    const records: AnswerRecord[] = [...done];
    let failure: unknown;
    let spent = 0;
    const runStart = Date.now();
    const first = todo[0];
    const firstOffset = offsets && first ? (offsets[questions.indexOf(first)] ?? 0) : 0;
    // Actual start of each question in this invocation (ms from its start), recorded with the arrivals.
    const startedMs: Record<string, number> = {};
    for (const q of todo) {
      const i = questions.indexOf(q);
      if (offsets) {
        const wait = runStart + ((offsets[i] ?? 0) - firstOffset) - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        startedMs[q.id] = Date.now() - runStart;
      }
      // Worst case for one question is 1 + maxRetries attempts; stop before the cap could be crossed.
      if (spent + 1 + config.embedding.maxRetries > maxRequests) {
        failure = new Error(`Stopped before ${q.id}: ${spent} generation requests used, cap ${maxRequests} (retries on 429/5xx). Partial run saved.`);
        console.error(errorMessage(failure));
        break;
      }
      try {
        const result = await answerQuestion(deps, q.question);
        const record = toAnswerRecord(q, result);
        records.push(record);
        await appendFile(partialFile, toJsonl([record]), 'utf8');
        spent += record.usage.generationRequests;
        console.log(
          `[${String(i + 1).padStart(2)}/${questions.length}] ${q.id} ${q.expected_behavior.padEnd(7)} -> ${record.status.padEnd(12)}` +
            `${record.floor_hit ? ' (floor)' : ''} ${(record.latency.totalMs / 1000).toFixed(2)} s` +
            (record.answered_by && mode === 'live' ? ` by ${record.answered_by}${record.hops ? ` (${record.hops} hop)` : ''}${record.hedged ? ' [hedged]' : ''}` : '') +
            (mode === 'live' && !embedCache ? ` | embed ${((record.latency.embeddingMs ?? 0) / 1000).toFixed(2)} s` : '') +
            (record.error ? ` [${record.error.slice(0, 80)}]` : ''),
        );
      } catch (error) {
        failure = error;
        console.error(`Stopped at ${q.id}: ${errorMessage(error)}`);
        break;
      }
    }

    if (failure !== undefined) {
      console.error(`Run incomplete: ${records.length}/${questions.length} answered. Resume with --resume ${rel(partialFile)}`);
      throw failure instanceof Error ? failure : new Error(errorMessage(failure));
    }
    // Keep question order regardless of resumes.
    const order = new Map(questions.map((q, i) => [q.id, i]));
    records.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const createdAt = new Date().toISOString();
    const metrics = computeCodeMetrics(records);
    const partial = records.length < questions.length;
    const payload = {
      kind: 'answers',
      set: 'dev',
      label,
      createdAt,
      partial,
      mode,
      sample: values.sample === undefined ? null : { n: questions.length, seed: SAMPLE_SEED },
      embedCache,
      arrivals: offsets ? { meanMs: arrivalMeanMs, seed: ARRIVAL_SEED, offsetsMs: offsets, startedMs, resumed: resumeFile !== undefined } : null,
      promptVersion,
      config: configSummary(config),
      metrics,
      records,
    };
    await writeFile(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeFile(
      `${base}.md`,
      `# Answers run (dev${label ? `, ${label}` : ''})\n\n- Created: ${createdAt}\n- Mode: ${mode}; prompt: ${promptVersion}; model${mode === 'live' ? ' chain' : ''} ${models}${partial ? '\n- PARTIAL RUN' : ''}\n\n${codeMetricsMarkdown(metrics)}`,
      'utf8',
    );
    const dir = await writeJudgeBatches(base, records.map(judgeItemFromRecord), batchSize);
    console.log(`\nBehavior accuracy ${pct(metrics.behavior.overall.value)} | citation precision (doc) ${pct(metrics.citations.documentPrecision.value)} | p95 ${(metrics.latencyMs.all.p95 / 1000).toFixed(2)} s`);
    console.log(`Run: ${rel(base)}.json | judge batches: ${rel(dir)}/ | judgments go to ${rel(base)}-judgments/`);
    await rm(partialFile, { force: true });
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
