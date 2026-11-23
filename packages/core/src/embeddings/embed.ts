import type { Acquisition, RateLimiterLike, Sleep } from '../ratelimit/limiter.ts';
import { estimateTokens } from '../tokens.ts';
import { embeddingCacheKey } from './cache-key.ts';
import { backoffDelayMs, type RetryPolicy } from './retry.ts';
import { EmbeddingApiError, type EmbeddingClient, type EmbeddingTaskType } from './types.ts';

export interface CachedEmbedding {
  readonly key: string;
  readonly model: string;
  readonly dimensions: number;
  readonly taskType: EmbeddingTaskType;
  readonly vector: readonly number[];
}

export interface EmbeddingCacheStore {
  getMany(keys: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>>;
  putMany(entries: readonly CachedEmbedding[]): Promise<void>;
}

/** One row per HTTP call to Gemini, successful or not (table api_usage). */
export interface UsageEvent {
  readonly kind: string;
  readonly model: string;
  /** Quota units: a batch of N texts is recorded as N requests (worst case). */
  readonly requests: number;
  readonly estTokens: number;
  /** HTTP status; 0 for network failures. */
  readonly httpStatus: number;
}

export interface UsageRecorder {
  record(event: UsageEvent): Promise<void>;
}

export interface EmbedDeps {
  readonly client: EmbeddingClient;
  readonly cache: EmbeddingCacheStore;
  readonly limiter: RateLimiterLike;
  readonly usage: UsageRecorder;
  readonly retry: RetryPolicy;
  readonly sleep: Sleep;
  readonly random: () => number;
  /** Usage kind, e.g. "embed_document" or "embed_query". */
  readonly kind: string;
  /** Multiplier on estimated tokens before asking the limiter (default 1.2). */
  readonly tokenSafetyFactor?: number;
  readonly onBatch?: (progress: { readonly done: number; readonly total: number }) => void;
}

export interface CacheMiss {
  readonly key: string;
  readonly text: string;
}

export interface CachePlan {
  /** Cache key per input text, in input order. */
  readonly keys: readonly string[];
  readonly cached: ReadonlyMap<string, readonly number[]>;
  /** Unique texts that still need an API call. */
  readonly misses: readonly CacheMiss[];
  /** Input texts (with duplicates) answered from the cache. */
  readonly cacheHits: number;
}

export interface EmbedStats {
  readonly httpCalls: number;
  readonly quotaRequests: number;
  readonly retries: number;
  readonly embeddedTexts: number;
  readonly estTokens: number;
  readonly observedHeaders: Readonly<Record<string, string>>;
  readonly errorStatuses: readonly number[];
}

export interface EmbedAllResult extends EmbedStats {
  readonly vectors: readonly (readonly number[])[];
  readonly cacheHits: number;
}

/** Computes cache keys and looks them up. Makes no API calls. */
export async function planEmbeddings(
  cache: EmbeddingCacheStore,
  embedding: { readonly model: string; readonly dimensions: number },
  texts: readonly string[],
  taskType: EmbeddingTaskType,
): Promise<CachePlan> {
  const { model, dimensions } = embedding;
  const keys = await Promise.all(texts.map((text) => embeddingCacheKey({ model, dimensions, taskType, text })));
  const unique = [...new Set(keys)];
  const cached = unique.length > 0 ? await cache.getMany(unique) : new Map<string, readonly number[]>();

  const misses: CacheMiss[] = [];
  const seen = new Set<string>();
  let cacheHits = 0;
  keys.forEach((key, i) => {
    if (cached.has(key)) {
      cacheHits++;
    } else if (!seen.has(key)) {
      seen.add(key);
      misses.push({ key, text: texts[i] ?? '' });
    }
  });
  return { keys, cached, misses, cacheHits };
}

/** Groups misses into batches bounded by count and by half the TPM budget. */
export function batchMisses(misses: readonly CacheMiss[], maxBatchSize: number, maxBatchTokens: number): CacheMiss[][] {
  const batches: CacheMiss[][] = [];
  let current: CacheMiss[] = [];
  let tokens = 0;
  for (const miss of misses) {
    const cost = estimateTokens(miss.text);
    if (current.length > 0 && (current.length >= maxBatchSize || tokens + cost > maxBatchTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(miss);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Embeds cache misses through the limiter, with retries on 429/5xx, writing
 * each batch to the cache as soon as it arrives so an interrupted run resumes
 * without spending quota twice. Every HTTP attempt is recorded as usage.
 */
export async function embedMisses(
  deps: EmbedDeps,
  misses: readonly CacheMiss[],
  taskType: EmbeddingTaskType,
  maxBatchTokens: number,
): Promise<{ vectors: Map<string, readonly number[]>; stats: EmbedStats }> {
  const factor = deps.tokenSafetyFactor ?? 1.2;
  const { client } = deps;
  const vectors = new Map<string, readonly number[]>();
  const observedHeaders: Record<string, string> = {};
  const errorStatuses: number[] = [];
  let httpCalls = 0;
  let quotaRequests = 0;
  let retries = 0;
  let estTokensTotal = 0;
  let done = 0;

  const batches = batchMisses(misses, client.maxBatchSize, Math.floor(maxBatchTokens / factor));
  for (const batch of batches) {
    const texts = batch.map((miss) => miss.text);
    const estTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
    const cost: Acquisition = { requests: batch.length, tokens: Math.ceil(estTokens * factor) };

    let result: Awaited<ReturnType<EmbeddingClient['embedBatch']>> | undefined;
    for (let attempt = 0; result === undefined; attempt++) {
      await deps.limiter.acquire(cost);
      httpCalls++;
      quotaRequests += batch.length;
      estTokensTotal += estTokens;
      try {
        result = await client.embedBatch(texts, taskType);
      } catch (error) {
        const status = error instanceof EmbeddingApiError ? error.status : 0;
        errorStatuses.push(status);
        await deps.usage.record({ kind: deps.kind, model: client.model, requests: batch.length, estTokens, httpStatus: status });
        if (!(error instanceof EmbeddingApiError) || !error.retryable || attempt >= deps.retry.maxRetries) throw error;
        retries++;
        await deps.sleep(backoffDelayMs(attempt, deps.retry, deps.random, error.retryAfterMs));
      }
    }

    await deps.usage.record({ kind: deps.kind, model: client.model, requests: batch.length, estTokens, httpStatus: 200 });
    Object.assign(observedHeaders, result.observedHeaders);
    const entries = batch.map((miss, i): CachedEmbedding => {
      const vector = result.vectors[i];
      if (!vector) throw new Error(`Missing vector ${i} in batch response.`);
      vectors.set(miss.key, vector);
      return { key: miss.key, model: client.model, dimensions: client.dimensions, taskType, vector };
    });
    await deps.cache.putMany(entries);
    done += batch.length;
    deps.onBatch?.({ done, total: misses.length });
  }

  return {
    vectors,
    stats: { httpCalls, quotaRequests, retries, embeddedTexts: vectors.size, estTokens: estTokensTotal, observedHeaders, errorStatuses },
  };
}

/** Cache lookup + embedding of misses, returning one vector per input text. */
export async function embedAll(
  deps: EmbedDeps,
  texts: readonly string[],
  taskType: EmbeddingTaskType,
  maxBatchTokens: number,
): Promise<EmbedAllResult> {
  const plan = await planEmbeddings(deps.cache, deps.client, texts, taskType);
  const { vectors: fresh, stats } = await embedMisses(deps, plan.misses, taskType, maxBatchTokens);
  const vectors = plan.keys.map((key) => {
    const vector = plan.cached.get(key) ?? fresh.get(key);
    if (!vector) throw new Error('Embedding missing after embedAll.');
    return vector;
  });
  return { ...stats, vectors, cacheHits: plan.cacheHits };
}
