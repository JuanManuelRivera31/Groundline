import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_RETRY_POLICY,
  embedMisses,
  fuseRrf,
  GeminiGenerationClient,
  pacificDayStart,
  planEmbeddings,
  RateLimiter,
  type AnswerEngineDeps,
  type AppConfig,
  type GenerationClient,
  type RetrievedChunk,
} from '@groundline/core';
import type { Db } from '@groundline/db';
import { cacheStoreFor, createEmbeddingClient, usageRecorderFor } from './io.ts';

const clock = { now: (): number => Date.now() };
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
  readonly generationQuota: QuotaStatus;
  readonly embeddingQuota: QuotaStatus;
}

export function createGenerationClient(config: AppConfig): GenerationClient | undefined {
  if (!config.geminiApiKey) return undefined;
  const g = config.generation;
  return new GeminiGenerationClient({
    apiKey: config.geminiApiKey,
    model: g.model,
    temperature: g.temperature,
    maxOutputTokens: g.maxOutputTokens,
    thinkingLevel: g.thinkingLevel,
    schemaField: g.schemaField,
    fetch: (url, init) => fetch(url, init),
  });
}

/**
 * Node wiring of the answer engine over PgDb: cache-first query embeddings,
 * vector (or hybrid) retrieval, Gemini generation behind its own limiter.
 * `embedKind` labels query-embedding rows in api_usage.
 */
export async function createAnswerRuntime(
  config: AppConfig,
  db: Db,
  options: { readonly embedKind: string; readonly generation?: GenerationClient | undefined },
): Promise<AnswerRuntime> {
  const emb = config.embedding;
  const gen = config.generation;
  const embeddingQuota = await quotaToday(db, emb.model, emb.limits.rpd);
  const generationQuota = await quotaToday(db, gen.model, gen.limits.rpd);
  const cache = cacheStoreFor(db);
  const usage = usageRecorderFor(db);
  const embedLimiter = new RateLimiter({ limits: emb.limits, clock, sleep, usedToday: embeddingQuota.used });
  const genLimiter = new RateLimiter({ limits: gen.limits, clock, sleep, usedToday: generationQuota.used });

  let generation = options.generation;
  const lazyGeneration: GenerationClient = {
    model: gen.model,
    generate: (request) => {
      generation ??= createGenerationClient(config);
      if (!generation) return Promise.reject(new Error('GEMINI_API_KEY is not set; cannot call the generation model.'));
      return generation.generate(request);
    },
  };

  const embedQuery = async (question: string): Promise<readonly number[]> => {
    const plan = await planEmbeddings(cache, emb, [question], 'RETRIEVAL_QUERY');
    const key = plan.keys[0] ?? '';
    const cached = plan.cached.get(key);
    if (cached) return cached;
    const client = createEmbeddingClient(config);
    if (!client) throw new Error('GEMINI_API_KEY is not set and the question is not cached.');
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

  return {
    embeddingQuota,
    generationQuota,
    deps: {
      config: {
        candidates: config.answer.candidates,
        sources: config.answer.sources,
        floor: config.answer.floor,
        embeddingModel: emb.model,
        maxOutputTokens: gen.maxOutputTokens,
      },
      embedQuery,
      retrieve,
      generation: lazyGeneration,
      call: {
        limiter: genLimiter,
        retry: { ...DEFAULT_RETRY_POLICY, maxRetries: emb.maxRetries },
        sleep,
        random: Math.random,
        clock,
      },
      usage,
      clock,
    },
  };
}
