import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY } from '../src/embeddings/retry.ts';
import { GeminiApiError, type FetchLike, type FetchResponseLike } from '../src/gemini/http.ts';
import { GeminiGenerationClient } from '../src/generation/gemini-generate.ts';
import { GenerationApiError } from '../src/generation/types.ts';
import { callWithRetry, type AttemptInfo } from '../src/ratelimit/call-with-retry.ts';
import { RateLimiter } from '../src/ratelimit/limiter.ts';
import { fakeTime } from './helpers.ts';

const API_KEY = 'test-key-not-a-real-secret';

function response(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => lower[name.toLowerCase()] ?? null,
      forEach: (cb) => {
        for (const [k, v] of Object.entries(lower)) cb(v, k);
      },
    },
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fakeFetch(...responses: (FetchResponseLike | Error)[]): { fetch: FetchLike; calls: { url: string; headers: Record<string, string>; body: unknown }[] } {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as unknown });
    const next = responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return next ? Promise.resolve(next) : Promise.reject(new Error('no more responses'));
  };
  return { fetch, calls };
}

const client = (fetch: FetchLike, extra: Partial<ConstructorParameters<typeof GeminiGenerationClient>[0]> = {}): GeminiGenerationClient =>
  new GeminiGenerationClient({ apiKey: API_KEY, model: 'gemini-test-lite', fetch, temperature: 0, maxOutputTokens: 512, thinkingLevel: 'MINIMAL', ...extra });

const okBody = {
  candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a":' }, { text: '1}' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 7, totalTokenCount: 157 },
};

describe('GeminiGenerationClient', () => {
  it('posts generateContent with the key only in the header and a JSON schema', async () => {
    const f = fakeFetch(response(200, okBody, { 'x-ratelimit-remaining': '9', 'content-type': 'application/json' }));
    const result = await client(f.fetch).generate({ system: 'SYS', user: 'USER', responseSchema: { type: 'object' } });
    const call = f.calls[0];
    expect(call?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test-lite:generateContent');
    expect(call?.url).not.toContain(API_KEY);
    expect(call?.headers['x-goog-api-key']).toBe(API_KEY);
    expect(call?.body).toEqual({
      systemInstruction: { parts: [{ text: 'SYS' }] },
      contents: [{ role: 'user', parts: [{ text: 'USER' }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    });
    expect(result).toEqual({
      text: '{"a":1}',
      finishReason: 'STOP',
      usage: { promptTokens: 120, outputTokens: 30, thoughtsTokens: 7, totalTokens: 157 },
      observedHeaders: { 'x-ratelimit-remaining': '9' },
    });
  });

  it('supports the legacy responseSchema field and omits thinkingConfig when disabled', async () => {
    const f = fakeFetch(response(200, okBody));
    await client(f.fetch, { schemaField: 'responseSchema', thinkingLevel: undefined }).generate({ system: 's', user: 'u', responseSchema: {} });
    const config = (f.calls[0]?.body as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(config).toHaveProperty('responseSchema');
    expect(config).not.toHaveProperty('responseJsonSchema');
    expect(config).not.toHaveProperty('thinkingConfig');
  });

  it('reports blocked prompts and missing usage without throwing', async () => {
    const f = fakeFetch(response(200, { promptFeedback: { blockReason: 'SAFETY' } }));
    const result = await client(f.fetch).generate({ system: 's', user: 'u', responseSchema: {} });
    expect(result.finishReason).toBe('BLOCKED:SAFETY');
    expect(result.text).toBe('');
    expect(result.usage.totalTokens).toBe(0);
  });

  it('marks 429 as retryable with the server delay and redacts the key', async () => {
    const body = {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: `quota for key ${API_KEY} exceeded`,
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }],
      },
    };
    const f = fakeFetch(response(429, body));
    const error = await client(f.fetch).generate({ system: 's', user: 'u', responseSchema: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationApiError);
    expect(error).toBeInstanceOf(GeminiApiError);
    const e = error as GenerationApiError;
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(12_000);
    expect(e.message).not.toContain(API_KEY);
    expect(e.message).toContain('[REDACTED]');
  });

  it('suggests the other schema field on an unknown-field 400', async () => {
    const f = fakeFetch(response(400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "responseJsonSchema"' } }));
    const error = (await client(f.fetch).generate({ system: 's', user: 'u', responseSchema: {} }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('GEN_SCHEMA_FIELD=responseSchema');
  });

  it('turns network failures into retryable errors without leaking the key', async () => {
    const f = fakeFetch(new Error(`socket closed ${API_KEY}`));
    const error = (await client(f.fetch).generate({ system: 's', user: 'u', responseSchema: {} }).catch((e: unknown) => e)) as GenerationApiError;
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(API_KEY);
  });
});

describe('callWithRetry', () => {
  const limits = { rpm: 10, tpm: 100_000, rpd: 200 };

  it('retries retryable errors, records every attempt and separates queue wait', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits, clock: t.clock, sleep: t.sleep });
    const attempts: AttemptInfo<string>[] = [];
    let n = 0;
    const result = await callWithRetry(
      { limiter, retry: DEFAULT_RETRY_POLICY, sleep: t.sleep, random: () => 0, clock: t.clock },
      { requests: 1, tokens: 100 },
      () => {
        n++;
        t.advance(500);
        if (n === 1) return Promise.reject(new GenerationApiError('busy', { status: 503, retryable: true }));
        return Promise.resolve('ok');
      },
      (info) => {
        attempts.push(info);
        return Promise.resolve();
      },
    );
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(attempts.map((a) => a.status)).toEqual([503, 200]);
    expect(attempts[1]?.result).toBe('ok');
    expect(result.queueWaitMs).toBe(0);
    // 2 × 500 ms calls + 1 000 ms backoff (equal jitter with random 0: half of 2 000).
    expect(result.callMs).toBe(2_000);
  });

  it('does not retry non-retryable errors', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits, clock: t.clock, sleep: t.sleep });
    const statuses: number[] = [];
    await expect(
      callWithRetry(
        { limiter, retry: DEFAULT_RETRY_POLICY, sleep: t.sleep, random: () => 0, clock: t.clock },
        { requests: 1, tokens: 1 },
        () => Promise.reject(new GenerationApiError('bad', { status: 400, retryable: false })),
        (info) => {
          statuses.push(info.status);
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow('bad');
    expect(statuses).toEqual([400]);
  });

  it('counts limiter waits as queue time', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits: { rpm: 1, tpm: 100_000, rpd: 200 }, clock: t.clock, sleep: t.sleep });
    const deps = { limiter, retry: DEFAULT_RETRY_POLICY, sleep: t.sleep, random: () => 0, clock: t.clock };
    const noop = (): Promise<void> => Promise.resolve();
    await callWithRetry(deps, { requests: 1, tokens: 1 }, () => Promise.resolve(1), noop);
    const second = await callWithRetry(deps, { requests: 1, tokens: 1 }, () => Promise.resolve(2), noop);
    expect(second.queueWaitMs).toBe(60_000);
    expect(second.callMs).toBe(0);
  });
});
