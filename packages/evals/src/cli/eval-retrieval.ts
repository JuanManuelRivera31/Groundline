import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  DEFAULT_RETRY_POLICY,
  embedMisses,
  pacificDayStart,
  planEmbeddings,
  RateLimiter,
} from '@groundline/core';
import { PgDb } from '@groundline/db/node';
import {
  cacheStoreFor,
  createEmbeddingClient,
  DEV_FILE,
  errorMessage,
  loadConfig,
  RUNS_DIR,
  usageRecorderFor,
} from '../io.ts';
import {
  assertSetAllowed,
  DEFAULT_RETRIEVAL_CONFIG,
  evaluateRetrieval,
  RETRIEVAL_MODES,
  runSummaryMarkdown,
  type RetrievalMode,
} from '../retrieval.ts';
import { parseJsonl, type EvalQuestion } from '../schema.ts';

const USAGE =
  'Usage: pnpm eval:retrieval --set dev --mode vector|fts|hybrid|all [--rrf-k 60] [--candidates 20] [--top 8] [--label name] [--dry-run]';

function intArg(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer in [${min}, ${max}].`);
  return n;
}

async function freePath(base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; existsSync(`${candidate}.json`); i++) candidate = `${base}-${i}`;
  return Promise.resolve(candidate);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      set: { type: 'string' },
      mode: { type: 'string', default: 'all' },
      'rrf-k': { type: 'string' },
      candidates: { type: 'string' },
      top: { type: 'string' },
      label: { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
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

  const modes: RetrievalMode[] =
    values.mode === 'all' ? [...RETRIEVAL_MODES] : RETRIEVAL_MODES.filter((m) => m === values.mode);
  if (modes.length === 0) throw new Error(`Unknown --mode ${values.mode}.`);
  const rrfK = intArg('rrf-k', values['rrf-k'], DEFAULT_RETRIEVAL_CONFIG.rrfK, 0, 10_000);
  const candidates = intArg('candidates', values.candidates, DEFAULT_RETRIEVAL_CONFIG.candidates, 1, 200);
  const topN = intArg('top', values.top, DEFAULT_RETRIEVAL_CONFIG.topN, 1, 50);
  if (topN > candidates) throw new Error('--top cannot exceed --candidates.');
  const label = values.label.replace(/[^\w-]/g, '');

  const questions = parseJsonl(await readFile(DEV_FILE, 'utf8')) as EvalQuestion[];
  const config = loadConfig();
  const { model, dimensions, limits } = config.embedding;
  const db = new PgDb(config.databaseUrl);
  try {
    // Quota check before any API call.
    const cache = cacheStoreFor(db);
    const plan = await planEmbeddings(cache, { model, dimensions }, questions.map((q) => q.question), 'RETRIEVAL_QUERY');
    const usedToday = await db.sumApiRequestsSince(new Date(pacificDayStart(Date.now())), model);
    const remaining = Math.max(0, limits.rpd - usedToday);
    console.log(`Dev set: ${questions.length} questions | cached query embeddings: ${plan.cacheHits}`);
    console.log(`Embedding requests needed: ${plan.misses.length} | remaining today (${model}): ${remaining} of ${limits.rpd}`);
    if (values['dry-run']) {
      console.log('Dry run: no API calls made.');
      return;
    }
    if (plan.misses.length > remaining) {
      throw new Error(`Not enough daily quota: need ${plan.misses.length}, ${remaining} remain. Retry after midnight Pacific time.`);
    }
    const vectors = new Map(plan.cached);
    if (plan.misses.length > 0) {
      const client = createEmbeddingClient(config);
      if (!client) throw new Error(`GEMINI_API_KEY is not set and ${plan.misses.length} questions are not cached.`);
      const result = await embedMisses(
        {
          client,
          cache,
          limiter: new RateLimiter({ limits, clock: { now: () => Date.now() }, sleep: (ms) => delay(ms), usedToday }),
          usage: usageRecorderFor(db),
          retry: { ...DEFAULT_RETRY_POLICY, maxRetries: config.embedding.maxRetries },
          sleep: (ms) => delay(ms),
          random: Math.random,
          kind: 'embed_query_eval',
          tokenSafetyFactor: 1.2,
        },
        plan.misses,
        'RETRIEVAL_QUERY',
        Math.floor(limits.tpm / 2),
      );
      for (const [key, vector] of result.vectors) vectors.set(key, vector);
      console.log(`Embedded ${result.stats.embeddedTexts} questions in ${result.stats.httpCalls} HTTP calls (${result.stats.quotaRequests} quota units).`);
    }

    const items = [];
    for (const [i, question] of questions.entries()) {
      const vector = vectors.get(plan.keys[i] ?? '');
      if (!vector) throw new Error(`Missing embedding for ${question.id}.`);
      items.push({
        question,
        lists: await db.searchCandidates({ query: question.question, vector, embeddingModel: model, vectorK: candidates, ftsK: candidates }),
      });
    }

    await mkdir(RUNS_DIR, { recursive: true });
    const createdAt = new Date().toISOString();
    const date = createdAt.slice(0, 10);
    for (const mode of modes) {
      const run = evaluateRetrieval(items, { mode, rrfK, candidates, topN });
      const base = await freePath(join(RUNS_DIR, `${date}-${mode}${label ? `-${label}` : ''}`));
      const payload = { set: 'dev', label, createdAt, embeddingModel: model, ...run };
      await writeFile(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await writeFile(`${base}.md`, runSummaryMarkdown(run, { set: 'dev', label, createdAt }), 'utf8');
      const s = run.metrics.section;
      const d = run.metrics.document;
      const fmt = (x: number): string => `${(x * 100).toFixed(1)}%`;
      console.log(
        `${mode.padEnd(6)} section R@1 ${fmt(s.recall['1']?.value ?? 0)} R@3 ${fmt(s.recall['3']?.value ?? 0)} ` +
          `R@5 ${fmt(s.recall['5']?.value ?? 0)} R@8 ${fmt(s.recall['8']?.value ?? 0)} MRR ${s.mrr.toFixed(3)} | ` +
          `doc R@8 ${fmt(d.recall['8']?.value ?? 0)} MRR ${d.mrr.toFixed(3)} -> ${base}.json`,
      );
    }
    const auc = evaluateRetrieval(items, { mode: 'vector', rrfK, candidates, topN }).metrics.signal.aucAnswerVsAbstain;
    console.log(`Max-cosine AUC answer vs abstain: ${auc.value.toFixed(3)} [${auc.lo.toFixed(3)}, ${auc.hi.toFixed(3)}]`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
