import { l2Normalize } from './normalize.ts';
import type { EmbedCallResult, EmbeddingApiError, EmbeddingClient, EmbeddingTaskType } from './types.ts';

export interface FakeEmbeddingCall {
  readonly texts: readonly string[];
  readonly taskType: EmbeddingTaskType;
}

/** FNV-1a 32-bit hash. */
function fnv1a(text: string, seed: number): number {
  let hash = 0x811c9dc5 ^ seed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic, offline stand-in for the Gemini client. The same text always
 * yields the same normalized vector. Scripted failures are thrown, in order,
 * before successful calls.
 */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  readonly calls: FakeEmbeddingCall[] = [];
  readonly #failures: EmbeddingApiError[];

  constructor(options: { model?: string; dimensions?: number; maxBatchSize?: number; failures?: EmbeddingApiError[] } = {}) {
    this.model = options.model ?? 'fake-embedding';
    this.dimensions = options.dimensions ?? 8;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.#failures = [...(options.failures ?? [])];
  }

  static vectorFor(text: string, dimensions: number): number[] {
    const raw = Array.from({ length: dimensions }, (_, i) => (fnv1a(text, i) / 0xffffffff) * 2 - 1);
    return l2Normalize(raw);
  }

  embedBatch(texts: readonly string[], taskType: EmbeddingTaskType): Promise<EmbedCallResult> {
    this.calls.push({ texts: [...texts], taskType });
    const failure = this.#failures.shift();
    if (failure) return Promise.reject(failure);
    if (texts.length > this.maxBatchSize) return Promise.reject(new Error('Batch too large'));
    return Promise.resolve({
      vectors: texts.map((text) => FakeEmbeddingClient.vectorFor(`${taskType}:${text}`, this.dimensions)),
      observedHeaders: {},
    });
  }
}
