import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  GeminiEmbeddingClient,
  parseConfig,
  type AppConfig,
  type EmbeddingCacheStore,
  type EmbeddingClient,
  type UsageRecorder,
} from '@groundline/core';
import type { Db } from '@groundline/db';
import { parseJsonl, type ChunkRef } from './schema.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const EVAL_WORK_DIR = join(REPO_ROOT, 'data', 'eval-work');
export const CHUNKS_FILE = join(EVAL_WORK_DIR, 'chunks.jsonl');
export const SETS_DIR = join(REPO_ROOT, 'evals', 'plausible');
export const RUNS_DIR = join(REPO_ROOT, 'evals', 'runs');
export const DEV_FILE = join(SETS_DIR, 'dev.jsonl');
export const TEST_FILE = join(SETS_DIR, 'test.jsonl');
export const MANIFEST_FILE = join(SETS_DIR, 'MANIFEST.json');

/**
 * Reads the frozen test set for the final run only, after checking its sha256
 * against MANIFEST.json; throws on any mismatch before the content is parsed.
 */
export async function readFrozenTestSet(): Promise<{ text: string; sha256: string }> {
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) as { sets?: { test?: { sha256?: string } } };
  const expected = manifest.sets?.test?.sha256;
  if (!expected) throw new Error('MANIFEST.json has no test sha256.');
  const text = await readFile(TEST_FILE, 'utf8');
  const actual = createHash('sha256').update(text).digest('hex');
  if (actual !== expected) throw new Error(`test.jsonl sha256 ${actual} does not match MANIFEST ${expected}; aborting.`);
  return { text, sha256: actual };
}

export function loadConfig(): AppConfig {
  const envFile = join(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return parseConfig(process.env);
}

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

export function cacheStoreFor(db: Db): EmbeddingCacheStore {
  return { getMany: (keys) => db.getCachedEmbeddings(keys), putMany: (entries) => db.putCachedEmbeddings(entries) };
}

export function usageRecorderFor(db: Db): UsageRecorder {
  return { record: (event) => db.recordApiUsage({ ...event, ingestRunId: null }) };
}

export async function loadChunkRefs(file: string = CHUNKS_FILE): Promise<ChunkRef[]> {
  if (!existsSync(file)) throw new Error(`Missing ${file}. Run "pnpm corpus:export --source plausible" first.`);
  return parseJsonl(await readFile(file, 'utf8')).map((row) => {
    const r = row as Record<string, unknown>;
    return { id: String(r.id), url: String(r.url), doc_path: String(r.doc_path) };
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
