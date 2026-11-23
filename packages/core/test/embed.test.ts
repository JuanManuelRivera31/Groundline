import { describe, expect, it } from 'vitest';
import { batchMisses, embedAll, type CachedEmbedding, type EmbedDeps, type EmbeddingCacheStore, type UsageEvent } from '../src/embeddings/embed.ts';
import { FakeEmbeddingClient } from '../src/embeddings/fake.ts';
import { EmbeddingApiError } from '../src/embeddings/types.ts';
import { RateLimiter } from '../src/ratelimit/limiter.ts';
import { fakeTime } from './helpers.ts';

class MemoryCache implements EmbeddingCacheStore {
  readonly entries = new Map<string, readonly number[]>();
  getMany(keys: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>> {
    const out = new Map<string, readonly number[]>();
    for (const key of keys) {
      const hit = this.entries.get(key);
      if (hit) out.set(key, hit);
    }
    return Promise.resolve(out);
  }
  putMany(entries: readonly CachedEmbedding[]): Promise<void> {
    for (const e of entries) this.entries.set(e.key, e.vector);
    return Promise.resolve();
  }
}

function setup(client = new FakeEmbeddingClient({ maxBatchSize: 2 })): { deps: EmbedDeps; client: FakeEmbeddingClient; usage: UsageEvent[]; cache: MemoryCache; sleeps: number[] } {
  const t = fakeTime();
  const usage: UsageEvent[] = [];
  const cache = new MemoryCache();
  const deps: EmbedDeps = {
    client,
    cache,
    limiter: new RateLimiter({ limits: { rpm: 60, tpm: 20_000, rpd: 800 }, clock: t.clock, sleep: t.sleep }),
    usage: {
      record: (event) => {
        usage.push(event);
        return Promise.resolve();
      },
    },
    retry: { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 10_000 },
    sleep: t.sleep,
    random: () => 0.5,
    kind: 'embed_document',
  };
  return { deps, client, usage, cache, sleeps: t.sleeps };
}

describe('embedAll', () => {
  it('embeds misses in batches, dedupes texts and records usage as N requests per batch', async () => {
    const { deps, client, usage } = setup();
    const result = await embedAll(deps, ['a', 'b', 'a', 'c'], 'RETRIEVAL_DOCUMENT', 10_000);
    expect(client.calls.map((c) => c.texts)).toEqual([['a', 'b'], ['c']]);
    expect(result.vectors).toHaveLength(4);
    expect(result.vectors[0]).toEqual(result.vectors[2]);
    expect(result).toMatchObject({ httpCalls: 2, quotaRequests: 3, cacheHits: 0, embeddedTexts: 3 });
    expect(usage.map((u) => [u.requests, u.httpStatus])).toEqual([
      [2, 200],
      [1, 200],
    ]);
  });

  it('makes zero API calls when everything is cached (idempotent re-run)', async () => {
    const { deps, client } = setup();
    await embedAll(deps, ['a', 'b', 'c'], 'RETRIEVAL_DOCUMENT', 10_000);
    const callsAfterFirst = client.calls.length;
    const second = await embedAll(deps, ['a', 'b', 'c'], 'RETRIEVAL_DOCUMENT', 10_000);
    expect(client.calls.length).toBe(callsAfterFirst);
    expect(second).toMatchObject({ httpCalls: 0, quotaRequests: 0, cacheHits: 3 });
  });

  it('keeps document and query embeddings apart in the cache', async () => {
    const { deps, client } = setup();
    await embedAll(deps, ['refund'], 'RETRIEVAL_DOCUMENT', 10_000);
    await embedAll(deps, ['refund'], 'RETRIEVAL_QUERY', 10_000);
    expect(client.calls.map((c) => c.taskType)).toEqual(['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY']);
  });

  it('retries 429 with backoff that honours retryDelay, recording every attempt', async () => {
    const failures = [
      new EmbeddingApiError('429', { status: 429, retryable: true, retryAfterMs: 17_000 }),
      new EmbeddingApiError('503', { status: 503, retryable: true }),
    ];
    const { deps, usage, sleeps } = setup(new FakeEmbeddingClient({ maxBatchSize: 2, failures }));
    const result = await embedAll(deps, ['a'], 'RETRIEVAL_DOCUMENT', 10_000);
    expect(sleeps).toEqual([17_000, 1_500]);
    expect(result).toMatchObject({ httpCalls: 3, quotaRequests: 3, retries: 2, errorStatuses: [429, 503] });
    expect(usage.map((u) => u.httpStatus)).toEqual([429, 503, 200]);
  });

  it('gives up after maxRetries and does not retry non-retryable errors', async () => {
    const many = Array.from({ length: 3 }, () => new EmbeddingApiError('429', { status: 429, retryable: true }));
    const a = setup(new FakeEmbeddingClient({ failures: many }));
    await expect(embedAll(a.deps, ['a'], 'RETRIEVAL_DOCUMENT', 10_000)).rejects.toThrow('429');
    expect(a.client.calls).toHaveLength(3);

    const b = setup(new FakeEmbeddingClient({ failures: [new EmbeddingApiError('400', { status: 400, retryable: false })] }));
    await expect(embedAll(b.deps, ['a'], 'RETRIEVAL_DOCUMENT', 10_000)).rejects.toThrow('400');
    expect(b.client.calls).toHaveLength(1);
  });

  it('writes each successful batch to the cache before the next one (resumable)', async () => {
    const { deps, cache } = setup(
      new FakeEmbeddingClient({ maxBatchSize: 1 }),
    );
    const failing: EmbedDeps = {
      ...deps,
      client: {
        ...deps.client,
        model: deps.client.model,
        dimensions: deps.client.dimensions,
        maxBatchSize: 1,
        embedBatch: (texts, taskType) =>
          texts[0] === 'b' ? Promise.reject(new EmbeddingApiError('400', { status: 400, retryable: false })) : deps.client.embedBatch(texts, taskType),
      },
    };
    await expect(embedAll(failing, ['a', 'b'], 'RETRIEVAL_DOCUMENT', 10_000)).rejects.toThrow();
    expect(cache.entries.size).toBe(1);
  });
});

describe('batchMisses', () => {
  it('bounds batches by count and by tokens', () => {
    const misses = ['x'.repeat(400), 'y'.repeat(400), 'z'.repeat(400), 'w'].map((text, i) => ({ key: String(i), text }));
    expect(batchMisses(misses, 10, 200).map((b) => b.length)).toEqual([2, 2]);
    expect(batchMisses(misses, 1, 10_000).map((b) => b.length)).toEqual([1, 1, 1, 1]);
  });
});

describe('FakeEmbeddingClient', () => {
  it('is deterministic and returns unit vectors of the configured size', async () => {
    const fake = new FakeEmbeddingClient({ dimensions: 16 });
    const [first] = (await fake.embedBatch(['hello'], 'RETRIEVAL_DOCUMENT')).vectors;
    const [again] = (await fake.embedBatch(['hello'], 'RETRIEVAL_DOCUMENT')).vectors;
    expect(first).toEqual(again);
    expect(first).toHaveLength(16);
    expect(Math.hypot(...(first ?? []))).toBeCloseTo(1, 10);
  });
});
