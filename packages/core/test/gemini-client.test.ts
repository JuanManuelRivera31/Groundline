import { describe, expect, it } from 'vitest';
import { GeminiEmbeddingClient, type FetchLike, type FetchResponseLike } from '../src/embeddings/gemini.ts';
import { EmbeddingApiError } from '../src/embeddings/types.ts';

const API_KEY = 'test-key-not-a-real-secret';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => lower[name.toLowerCase()] ?? null,
      forEach: (callback) => {
        for (const [k, v] of Object.entries(lower)) callback(v, k);
      },
    },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fakeFetch(...responses: FetchResponseLike[]): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as unknown });
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('no more responses'));
  };
  return { fetch, calls };
}

const client = (fetch: FetchLike, extra: Partial<ConstructorParameters<typeof GeminiEmbeddingClient>[0]> = {}): GeminiEmbeddingClient =>
  new GeminiEmbeddingClient({ apiKey: API_KEY, model: 'gemini-embedding-001', dimensions: 3, maxBatchSize: 2, fetch, ...extra });

describe('GeminiEmbeddingClient', () => {
  it('sends a batchEmbedContents request with the key only in the header', async () => {
    const f = fakeFetch(response(200, { embeddings: [{ values: [3, 0, 4] }, { values: [0, 2, 0] }] }));
    const result = await client(f.fetch).embedBatch(['a', 'b'], 'RETRIEVAL_DOCUMENT');

    const call = f.calls[0];
    expect(call?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
    expect(call?.url).not.toContain(API_KEY);
    expect(call?.headers['x-goog-api-key']).toBe(API_KEY);
    expect(call?.body).toEqual({
      requests: [
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'a' }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 3 },
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'b' }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 3 },
      ],
    });
    expect(JSON.stringify(call?.body)).not.toContain('title');
    // L2-normalized.
    expect(result.vectors).toEqual([
      [0.6, 0, 0.8],
      [0, 1, 0],
    ]);
  });

  it('can nest options under embedContentConfig', async () => {
    const f = fakeFetch(response(200, { embeddings: [{ values: [1, 0, 0] }] }));
    await client(f.fetch, { requestShape: 'config' }).embedBatch(['q'], 'RETRIEVAL_QUERY');
    expect(f.calls[0]?.body).toEqual({
      requests: [
        {
          model: 'models/gemini-embedding-001',
          content: { parts: [{ text: 'q' }] },
          embedContentConfig: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 3 },
        },
      ],
    });
  });

  it('maps 429 to a retryable error with RetryInfo delay and observed headers are filtered', async () => {
    const f = fakeFetch(
      response(429, {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: `Quota exceeded for key ${API_KEY}`,
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }],
        },
      }),
    );
    const error = await client(f.fetch).embedBatch(['a'], 'RETRIEVAL_DOCUMENT').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingApiError);
    const apiError = error as EmbeddingApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.retryable).toBe(true);
    expect(apiError.retryAfterMs).toBe(17_000);
    expect(apiError.message).toContain('RESOURCE_EXHAUSTED');
    expect(apiError.message).not.toContain(API_KEY);
  });

  it('uses Retry-After when there is no RetryInfo, and treats 400 as non-retryable', async () => {
    const f = fakeFetch(response(503, 'unavailable', { 'Retry-After': '5' }), response(400, { error: { message: 'Unknown name "taskType"' } }));
    const c = client(f.fetch);
    const e503 = (await c.embedBatch(['a'], 'RETRIEVAL_DOCUMENT').catch((e: unknown) => e)) as EmbeddingApiError;
    expect([e503.retryable, e503.retryAfterMs]).toEqual([true, 5_000]);
    const e400 = (await c.embedBatch(['a'], 'RETRIEVAL_DOCUMENT').catch((e: unknown) => e)) as EmbeddingApiError;
    expect(e400.retryable).toBe(false);
    expect(e400.message).toContain('Set GEMINI_EMBED_REQUEST_SHAPE=config in .env');
    expect(e400.message).not.toContain(API_KEY);
  });

  it('rejects wrong dimensions, wrong counts and oversized batches', async () => {
    const wrongDims = fakeFetch(response(200, { embeddings: [{ values: [1, 2] }] }));
    await expect(client(wrongDims.fetch).embedBatch(['a'], 'RETRIEVAL_DOCUMENT')).rejects.toThrow(/expected 3/);
    const wrongCount = fakeFetch(response(200, { embeddings: [] }));
    await expect(client(wrongCount.fetch).embedBatch(['a'], 'RETRIEVAL_DOCUMENT')).rejects.toThrow(/0 embeddings for 1/);
    await expect(client(fakeFetch().fetch).embedBatch(['a', 'b', 'c'], 'RETRIEVAL_DOCUMENT')).rejects.toThrow(/maxBatchSize/);
  });

  it('wraps network failures as retryable status 0', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const error = (await client(fetch).embedBatch(['a'], 'RETRIEVAL_DOCUMENT').catch((e: unknown) => e)) as EmbeddingApiError;
    expect([error.status, error.retryable]).toEqual([0, true]);
  });

  it('collects rate-limit related response headers only', async () => {
    const f = fakeFetch(response(200, { embeddings: [{ values: [1, 0, 0] }] }, { 'X-RateLimit-Remaining': '10', 'Content-Type': 'application/json' }));
    const result = await client(f.fetch).embedBatch(['a'], 'RETRIEVAL_DOCUMENT');
    expect(result.observedHeaders).toEqual({ 'x-ratelimit-remaining': '10' });
  });

  it('refuses to start without an API key', () => {
    expect(() => client(fakeFetch().fetch, { apiKey: '' })).toThrow(/GEMINI_API_KEY/);
  });
});
