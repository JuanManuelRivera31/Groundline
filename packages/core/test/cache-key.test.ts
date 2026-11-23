import { describe, expect, it } from 'vitest';
import { embeddingCacheKey, type CacheKeyInput } from '../src/embeddings/cache-key.ts';
import { sha256Hex } from '../src/hash.ts';

const base: CacheKeyInput = { model: 'gemini-embedding-001', dimensions: 768, taskType: 'RETRIEVAL_DOCUMENT', text: 'Billing > Refunds\n\nText' };

describe('embeddingCacheKey', () => {
  it('is a stable sha256 hex digest', async () => {
    const key = await embeddingCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await embeddingCacheKey({ ...base })).toBe(key);
  });

  it.each<[string, Partial<CacheKeyInput>]>([
    ['model', { model: 'gemini-embedding-2' }],
    ['dimensions', { dimensions: 1536 }],
    ['task type', { taskType: 'RETRIEVAL_QUERY' }],
    ['text', { text: 'Billing > Refunds\n\nText!' }],
    ['title', { title: 'Billing' }],
  ])('changes when the %s changes', async (_name, change) => {
    expect(await embeddingCacheKey({ ...base, ...change })).not.toBe(await embeddingCacheKey(base));
  });

  it('cannot collide through field boundaries', async () => {
    const a = await embeddingCacheKey({ ...base, model: 'm|1', text: 't' });
    const b = await embeddingCacheKey({ ...base, model: 'm', text: '1|t' });
    expect(a).not.toBe(b);
  });
});

describe('sha256Hex', () => {
  it('matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
