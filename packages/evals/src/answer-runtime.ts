import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_RETRY_POLICY,
  embedMisses,
  fuseRrf,
  GeminiGenerationClient,
  pacificDayStart,
  planEmbeddings,
  RateLimiter,
  estimateTokens,
  GeminiApiError,
  type AnswerEngineDeps,
  type AnswerMode,
  type AppConfig,
  type EmbedQueryOptions,
  type GenerationClient,
  type GenerationTarget,
  type RetrievedChunk,
} from '@groundline/core';
import type { Db } from '@groundline/db';
import { cacheStoreFor, createEmbeddingClient, usageRecorderFor } from './io.ts';

const clock = { now: (): number => Date.now() };

/**
 * Generation 503s come in "high demand" bursts lasting minutes. A slower
 * backoff spends fewer quota-counted attempts per burst than the embedding one.
 */
export const GENERATION_RETRY_POLICY = { baseDelayMs: 5_000, maxDelayMs: 120_000 } as const;
const sleep = (ms: number): Promise<void> => delay(ms);

export interface QuotaStatus {
  readonly model: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
}

export async function quotaToday(db: Db, model: string, rpd: number): Promise<QuotaStatus> {
  const used = await db.sumApiRequestsSince(new Date(pacificDayStart(Date.now())), model);
  return { model, used, limit: rpd, remaining: Math.max(0, rpd - used) };
}

export interface AnswerRuntime {
  readonly deps: AnswerEngineDeps;
  /** Primary model quota (eval mode). */
  readonly generationQuota: QuotaStatus;
  /** Quota of every model in the chain, primary first. */
  readonly generationQuotas: readonly QuotaStatus[];
  readonly embeddingQuota: QuotaStatus;
}

export function createGenerationClient(config: AppConfig, model: string = config.generation.model): GenerationClient | undefined {
  if (!config.geminiApiKey) return undefined;
  const g = config.generation;
  return new GeminiGenerationClient({
    apiKey: config.geminiApiKey,
    model,
    temperature: g.temperature,
    maxOutputTokens: g.maxOutputTokens,
    thinkingLevel: g.thinkingLevel,
    schemaField: g.schemaField,
    fetch: (url, init) => fetch(url, { ...init, signal: init.signal ?? null }),
  });
}

/**
 * Node wiring of the answer engine over PgDb: cache-first query embeddings,
 * vector (or hybrid) retrieval, full-text fallback, and one Gemini client plus
 * limiter per chain model. `mode` picks eval (primary only, patient retries)
 * or live (chain within GEN_LIVE_BUDGET_MS). `embedKind` labels query rows.
 */
export async function createAnswerRuntime(
  config: AppConfig,
  db: Db,
  options: {
    readonly embedKind: string;
    readonly mode?: AnswerMode | undefined;
    readonly promptVersion?: string | undefined;
    /** Eval mode: measure this model instead of the chain's primary. */
    readonly primaryModel?: string | undefined;
  },
): Promise<AnswerRuntime> {
  const emb = config.embedding;
  const gen = config.generation;
  const mode: AnswerMode = options.mode ?? 'eval';
  const embeddingQuota = await quotaToday(db, emb.model, emb.limits.rpd);
  const models = mode === 'eval' ? [options.primaryModel ?? gen.model] : gen.models;
  const generationQuotas: QuotaStatus[] = [];
  for (const m of models) generationQuotas.push(await quotaToday(db, m, (gen.limitsByModel[m] ?? gen.limits).rpd));
  const cache = cacheStoreFor(db);
  const usage = usageRecorderFor(db);
  const embedLimiter = new RateLimiter({ limits: emb.limits, clock, sleep, usedToday: embeddingQuota.used });

  const chain: GenerationTarget[] = models.map((model, i) => {
    let client: GenerationClient | undefined;
    return {
      client: {
        model,
        generate: (request) => {
          client ??= createGenerationClient(config, model);
          if (!client) return Promise.reject(new Error('GEMINI_API_KEY is not set; cannot call the generation model.'));
          return client.generate(request);
        },
      },
      limiter: new RateLimiter({ limits: gen.limitsByModel[model] ?? gen.limits, clock, sleep, usedToday: generationQuotas[i]?.used ?? 0 }),
    };
  });

  const embedQuery = async (question: string, opts: EmbedQueryOptions): Promise<readonly number[]> => {
    const plan = await planEmbeddings(cache, emb, [question], 'RETRIEVAL_QUERY');
    const key = plan.keys[0] ?? '';
    const cached = plan.cached.get(key);
    if (cached) return cached;
    const client = createEmbeddingClient(config);
    if (!client) throw new Error('GEMINI_API_KEY is not set and the question is not cached.');
    if (opts.mode === 'live') {
      // One attempt within the live budget: no backoff, no waiting for the minute window.
      const timeoutMs = Math.max(1, opts.timeoutMs ?? 0);
      const estTokens = estimateTokens(question);
      await embedLimiter.acquire({ requests: 1, tokens: Math.ceil(estTokens * 1.2) }, { maxWaitMs: Math.max(0, timeoutMs - 300) });
      const started = Date.now();
      try {
        const { vectors } = await client.embedBatch([question], 'RETRIEVAL_QUERY', { signal: AbortSignal.timeout(timeoutMs) });
        const vector = vectors[0];
        if (!vector) throw new Error('Query embedding missing in response.');
        await usage.record({ kind: options.embedKind, model: emb.model, requests: 1, estTokens, httpStatus: 200, latencyMs: Date.now() - started });
        await cache.putMany([{ key, model: emb.model, dimensions: emb.dimensions, taskType: 'RETRIEVAL_QUERY', vector }]);
        return vector;
      } catch (error) {
        const status = error instanceof GeminiApiError ? error.status : 0;
        await usage.record({ kind: options.embedKind, model: emb.model, requests: 1, estTokens, httpStatus: status, latencyMs: Date.now() - started });
        throw error;
      }
    }
    const { vectors } = await embedMisses(
      {
        client,
        cache,
        limiter: embedLimiter,
        usage,
        retry: { ...DEFAULT_RETRY_POLICY, maxRetries: emb.maxRetries },
        sleep,
        random: Math.random,
        kind: options.embedKind,
      },
      plan.misses,
      'RETRIEVAL_QUERY',
      Math.floor(emb.limits.tpm / 2),
    );
    const vector = vectors.get(key);
    if (!vector) throw new Error('Query embedding missing after embedding call.');
    return vector;
  };

  const retrieve = async (question: string, vector: readonly number[], candidates: number): Promise<RetrievedChunk[]> => {
    if (config.answer.retrievalMode === 'vector') {
      const hits = await db.searchVector(vector, emb.model, candidates);
      return hits.map((h) => ({ ...h, cosine: h.score }));
    }
    const lists = await db.searchCandidates({ query: question, vector, embeddingModel: emb.model, vectorK: candidates, ftsK: candidates });
    const fused = fuseRrf(
      [
        { name: 'vector', items: lists.vector },
        { name: 'fts', items: lists.fullText },
      ],
      { limit: candidates },
    );
    return fused.map((f) => ({ ...f.item, cosine: f.cosine }));
  };

  const searchFullText = async (question: string, limit: number): Promise<RetrievedChunk[]> =>
    (await db.searchFullText(question, limit)).map((h) => ({ ...h, cosine: null }));

  return {
    embeddingQuota,
    generationQuota: generationQuotas[0] ?? { model: gen.model, used: 0, limit: gen.limits.rpd, remaining: gen.limits.rpd },
    generationQuotas,
    deps: {
      mode,
      config: {
        candidates: config.answer.candidates,
        sources: config.answer.sources,
        floor: config.answer.floor,
        embeddingModel: emb.model,
        maxOutputTokens: gen.maxOutputTokens,
        promptVersion: options.promptVersion ?? config.answer.promptVersion,
        liveBudgetMs: gen.liveBudgetMs,
      },
      embedQuery,
      retrieve,
      searchFullText,
      chain,
      retry: { ...DEFAULT_RETRY_POLICY, ...GENERATION_RETRY_POLICY, maxRetries: emb.maxRetries },
      sleep,
      random: Math.random,
      clock,
      usage,
    },
  };
}
