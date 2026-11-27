import { GeminiEmbeddingClient, type AppConfig, type EmbeddingCacheStore, type EmbeddingClient, type UsageRecorder } from '@groundline/core';
import type { Db } from '@groundline/db';

// Runtime-agnostic helpers (no node:* imports): shared by the Node CLIs and the
// API, which also runs on Cloudflare Workers.

export function createEmbeddingClient(config: AppConfig): EmbeddingClient | undefined {
  if (!config.geminiApiKey) return undefined;
  return new GeminiEmbeddingClient({
    apiKey: config.geminiApiKey,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
    maxBatchSize: config.embedding.batchSize,
    requestShape: config.embedding.requestShape,
    fetch: (url, init) => fetch(url, { ...init, signal: init.signal ?? null }),
  });
}

export function cacheStoreFor(db: Pick<Db, 'getCachedEmbeddings' | 'putCachedEmbeddings'>): EmbeddingCacheStore {
  return { getMany: (keys) => db.getCachedEmbeddings(keys), putMany: (entries) => db.putCachedEmbeddings(entries) };
}

export function usageRecorderFor(db: Pick<Db, 'recordApiUsage'>): UsageRecorder {
  return { record: (event) => db.recordApiUsage({ ...event, ingestRunId: null }) };
}
