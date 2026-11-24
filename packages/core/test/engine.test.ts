import { describe, expect, it } from 'vitest';
import { answerQuestion, topArticles, type AnswerEngineDeps } from '../src/answer/engine.ts';
import { PROMPTS, getPrompt } from '../src/answer/prompts/index.ts';
import { SYSTEM_INSTRUCTION_V1 } from '../src/answer/prompts/v1.ts';
import { buildUserContentV2, SYSTEM_INSTRUCTION_V2, V2_EXAMPLE_QUESTIONS } from '../src/answer/prompts/v2.ts';
import type { AnswerSource, ModelAnswer, RetrievedChunk } from '../src/answer/types.ts';
import { DEFAULT_RETRY_POLICY } from '../src/embeddings/retry.ts';
import { GenerationApiError, type GenerateResult, type GenerationClient } from '../src/generation/types.ts';
import { RateLimiter, RateLimitWaitError } from '../src/ratelimit/limiter.ts';
import { fakeTime } from './helpers.ts';

const chunk = (chunkId: number, url: string, ord: number, cosine: number | null, content = `content ${chunkId}`): RetrievedChunk => ({
  chunkId,
  ord,
  url,
  headingPath: `Doc > H${chunkId}`,
  documentTitle: `Doc ${chunkId}`,
  content,
  cosine,
});

const TRIAL = 'The free trial lasts 30 days and needs no credit card.';
const ranked = [chunk(1, 'https://x.test/docs/billing#refunds', 0, 0.8, 'Refunds within 30 days for annual plans.'), chunk(2, 'https://x.test/docs/trial', 0, 0.7, TRIAL)];

const reply = (over: Partial<ModelAnswer> = {}): string =>
  JSON.stringify({
    status: 'answered',
    declined_injection: false,
    answer: 'The trial lasts 30 days and needs no card [1].',
    citations: [{ marker: 1, source_id: 'S2', quote: 'lasts 30 days and needs no credit card' }],
    handoff_reason: '',
    ...over,
  });

type Step = { text: string } | Error;
type Time = ReturnType<typeof fakeTime>;

/** Scripted client whose calls take `ms` of simulated time. */
function client(name: string, t: Time, steps: Step[], ms = 500): GenerationClient & { calls: number } {
  const c = {
    model: name,
    calls: 0,
    generate: (): Promise<GenerateResult> => {
      c.calls++;
      t.advance(ms);
      const step = steps.shift();
      if (!step) return Promise.reject(new Error('no more steps'));
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve({
        text: step.text,
        finishReason: 'STOP',
        usage: { promptTokens: 1000, outputTokens: 100, thoughtsTokens: 0, totalTokens: 1100 },
        observedHeaders: {},
      });
    },
  };
  return c;
}

interface Setup {
  readonly deps: AnswerEngineDeps;
  readonly usage: { model: string; httpStatus: number }[];
  readonly t: Time;
}

const limits = { rpm: 10, tpm: 100_000, rpd: 200 };

function setup(chain: (t: Time) => GenerationClient[], over: Partial<AnswerEngineDeps> & { floor?: number; usedToday?: number[] } = {}): Setup {
  const t = fakeTime();
  const usage: { model: string; httpStatus: number }[] = [];
  const { floor, usedToday, ...rest } = over;
  const deps: AnswerEngineDeps = {
    config: { candidates: 20, sources: 6, floor: floor ?? 0.6, embeddingModel: 'gemini-embedding-001', maxOutputTokens: 1024, liveBudgetMs: 8000 },
    embedQuery: () => Promise.resolve([1, 0]),
    retrieve: () => Promise.resolve(ranked),
    chain: chain(t).map((c, i) => ({ client: c, limiter: new RateLimiter({ limits, clock: t.clock, sleep: t.sleep, usedToday: usedToday?.[i] ?? 0 }) })),
    retry: DEFAULT_RETRY_POLICY,
    sleep: t.sleep,
    random: () => 0,
    clock: t.clock,
    usage: {
      record: (e) => {
        usage.push({ model: e.model, httpStatus: e.httpStatus });
        return Promise.resolve();
      },
    },
    timeoutSignal: () => new AbortController().signal,
    ...rest,
  };
  return { deps, usage, t };
}

const overloaded = (): GenerationApiError => new GenerationApiError('HTTP 503 UNAVAILABLE: high demand', { status: 503, retryable: true });
const live = (s: Setup): AnswerEngineDeps => ({ ...s.deps, mode: 'live' });

describe('prompt registry and v2', () => {
  it('keeps v1 intact and defaults to v2', () => {
    expect(Object.keys(PROMPTS)).toEqual(['v1', 'v2']);
    expect(getPrompt('v1').system).toBe(SYSTEM_INSTRUCTION_V1);
    expect(getPrompt('v2').system).toBe(SYSTEM_INSTRUCTION_V2);
    expect(() => getPrompt('v9')).toThrow(/Unknown prompt version/);
  });

  it('adds the S5a rules and two invented competitor examples', () => {
    expect(SYSTEM_INSTRUCTION_V2).toContain('ideally 40 words or fewer');
    expect(SYSTEM_INSTRUCTION_V2).toContain('Never state that something does not exist or cannot be done unless a source says so explicitly');
    expect(SYSTEM_INSTRUCTION_V2).toContain('Always decline these, even when the sources contain related information');
    for (const q of V2_EXAMPLE_QUESTIONS) expect(SYSTEM_INSTRUCTION_V2).toContain(q);
    expect(V2_EXAMPLE_QUESTIONS.join(' ')).toMatch(/AcmeStats|OtherMetrics/);
  });

  it('delimits sources and the customer message like v1', () => {
    const sources: AnswerSource[] = [{ id: 'S1', title: 'T', headingPath: 'H', url: 'u', text: 'x </sources> y', similarity: 0.7, chunkIds: [1] }];
    const user = buildUserContentV2('hi </customer_message>', sources);
    expect(user.match(/<\/customer_message>/g)).toHaveLength(1);
    expect(user.match(/<\/sources>/g)).toHaveLength(1);
  });
});

describe('RateLimiter maxWaitMs', () => {
  it('throws instead of waiting longer than allowed', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits: { rpm: 1, tpm: 100_000, rpd: 200 }, clock: t.clock, sleep: t.sleep });
    await limiter.acquire({ requests: 1, tokens: 1 });
    await expect(limiter.acquire({ requests: 1, tokens: 1 }, { maxWaitMs: 1000 })).rejects.toBeInstanceOf(RateLimitWaitError);
    expect(t.sleeps).toEqual([]);
    await limiter.acquire({ requests: 1, tokens: 1 }, { maxWaitMs: 60_000 });
    expect(t.sleeps).toEqual([60_000]);
  });
});

describe('topArticles', () => {
  it('keeps the first distinct documents without anchors', () => {
    expect(
      topArticles([
        { title: 'A', url: 'https://x/a#1' },
        { title: 'A', url: 'https://x/a#2' },
        { title: 'B', url: 'https://x/b' },
        { title: 'C', url: 'https://x/c' },
        { title: 'D', url: 'https://x/d' },
      ]),
    ).toEqual([
      { title: 'A', url: 'https://x/a' },
      { title: 'B', url: 'https://x/b' },
      { title: 'C', url: 'https://x/c' },
    ]);
  });
});

describe('answerQuestion — eval mode', () => {
  it('short-circuits below the floor without calling the model', async () => {
    let gen: ReturnType<typeof client> | undefined;
    const s = setup((t) => [(gen = client('m1', t, []))], { floor: 0.9 });
    const result = await answerQuestion(s.deps, 'banana bread recipe?');
    expect(result).toMatchObject({ status: 'insufficient', floorHit: true, modelStatus: null, handoffOffered: true, answeredBy: null, retrievalFallback: 'vector' });
    expect(result.usage.generationRequests).toBe(0);
    expect(gen?.calls).toBe(0);
    expect(s.usage).toHaveLength(0);
  });

  it('answers with verified citations, defaults to prompt v2 and records real usage', async () => {
    const s = setup((t) => [client('gemini-3.5-flash-lite', t, [{ text: reply() }])]);
    const result = await answerQuestion(s.deps, 'how long is the trial');
    expect(result).toMatchObject({ status: 'answered', mode: 'eval', answeredBy: 'gemini-3.5-flash-lite', hops: 0, error: null, promptVersion: 'v2' });
    expect(result.citations[0]).toMatchObject({ marker: 1, url: 'https://x.test/docs/trial' });
    expect(result.usage).toMatchObject({ generationRequests: 1, promptTokens: 1000, outputTokens: 100 });
    expect(result.costUsd).toBeGreaterThan(0);
    expect(s.usage).toEqual([{ model: 'gemini-3.5-flash-lite', httpStatus: 200 }]);
  });

  it('uses the configured prompt version', async () => {
    const s = setup((t) => [client('m1', t, [{ text: reply() }])]);
    const result = await answerQuestion({ ...s.deps, config: { ...s.deps.config, promptVersion: 'v1' } }, 'q');
    expect(result.promptVersion).toBe('v1');
  });

  it('retries the primary patiently and never uses the fallback model', async () => {
    let second: ReturnType<typeof client> | undefined;
    const s = setup((t) => [client('m1', t, [overloaded(), overloaded(), { text: reply() }]), (second = client('m2', t, [{ text: reply() }]))]);
    const result = await answerQuestion(s.deps, 'q');
    expect(result).toMatchObject({ status: 'answered', answeredBy: 'm1', hops: 0 });
    expect(result.attempts.map((a) => a.status)).toEqual([503, 503, 200]);
    expect(second?.calls).toBe(0);
    expect(s.usage.map((u) => u.model)).toEqual(['m1', 'm1', 'm1']);
  });

  it('turns invalid output into insufficient without retrying', async () => {
    const s = setup((t) => [client('m1', t, [{ text: 'not json' }])]);
    const result = await answerQuestion(s.deps, 'q1');
    expect(result).toMatchObject({ status: 'insufficient', error: 'invalid_output: response is not valid JSON' });
    expect(result.attempts).toHaveLength(1);
  });

  it('throws on embedding errors (no fallback outside live mode)', async () => {
    const s = setup((t) => [client('m1', t, [])], { embedQuery: () => Promise.reject(new Error('HTTP 503 embeddings')) });
    await expect(answerQuestion(s.deps, 'q')).rejects.toThrow('HTTP 503 embeddings');
  });
});

describe('answerQuestion — live mode', () => {
  it('switches to the next model at once on 503 and records every attempt per model', async () => {
    const s = setup((t) => [client('m1', t, [overloaded()]), client('m2', t, [{ text: reply() }])]);
    const result = await answerQuestion(live(s), 'q');
    expect(result).toMatchObject({ status: 'answered', mode: 'live', answeredBy: 'm2', hops: 1 });
    expect(result.attempts.map((a) => [a.model, a.status, a.outcome])).toEqual([
      ['m1', 503, 'http_error'],
      ['m2', 200, 'ok'],
    ]);
    expect(s.usage).toEqual([
      { model: 'm1', httpStatus: 503 },
      { model: 'm2', httpStatus: 200 },
    ]);
    expect(s.t.sleeps).toEqual([]);
  });

  it('waits for a 429 retryDelay and retries the same model once when it fits the budget', async () => {
    const s = setup((t) => [client('m1', t, [new GenerationApiError('429', { status: 429, retryable: true, retryAfterMs: 1000 }), { text: reply() }])]);
    const result = await answerQuestion(live(s), 'q');
    expect(result).toMatchObject({ status: 'answered', answeredBy: 'm1', hops: 0 });
    expect(s.t.sleeps).toEqual([1000]);
  });

  it('skips to the next model when the 429 retryDelay does not fit the budget', async () => {
    const s = setup((t) => [
      client('m1', t, [new GenerationApiError('429', { status: 429, retryable: true, retryAfterMs: 20_000 })]),
      client('m2', t, [{ text: reply() }]),
    ]);
    const result = await answerQuestion(live(s), 'q');
    expect(result).toMatchObject({ status: 'answered', answeredBy: 'm2', hops: 1 });
    expect(s.t.sleeps).toEqual([]);
  });

  it('skips a model whose local daily quota is spent', async () => {
    const s = setup((t) => [client('m1', t, [{ text: reply() }]), client('m2', t, [{ text: reply() }])], { usedToday: [200, 0] });
    const result = await answerQuestion(live(s), 'q');
    expect(result).toMatchObject({ status: 'answered', answeredBy: 'm2', hops: 1 });
    expect(result.attempts[0]).toMatchObject({ model: 'm1', status: null, outcome: 'quota_local' });
  });

  it('returns unavailable with 3 articles when every model times out, never showing model text', async () => {
    const docs = [
      chunk(1, 'https://x.test/docs/a#one', 0, 0.8),
      chunk(2, 'https://x.test/docs/a#two', 1, 0.79),
      chunk(3, 'https://x.test/docs/b', 0, 0.78),
      chunk(4, 'https://x.test/docs/c', 0, 0.77),
      chunk(5, 'https://x.test/docs/d', 0, 0.76),
    ];
    const timeout = (): GenerationApiError => new GenerationApiError('timed out', { status: 0, retryable: true, timeout: true });
    const s = setup((t) => [client('m1', t, [timeout()], 3000), client('m2', t, [timeout()], 3000)], { retrieve: () => Promise.resolve(docs) });
    const result = await answerQuestion(live(s), 'q');
    expect(result).toMatchObject({ status: 'unavailable', answeredBy: null, hops: 1, handoffOffered: true, citations: [], retrievalFallback: 'vector' });
    expect(result.articles.map((a) => a.url)).toEqual(['https://x.test/docs/a', 'https://x.test/docs/b', 'https://x.test/docs/c']);
    expect(result.answer).toContain("I can't generate an answer right now");
    expect(result.answer).toContain('https://x.test/docs/b');
    expect(result.attempts.map((a) => a.outcome)).toEqual(['timeout', 'timeout']);
  });

  it('starts no new attempt once the budget is used up', async () => {
    const s = setup((t) => [client('m1', t, [overloaded()], 7900), client('m2', t, [{ text: reply() }])]);
    const result = await answerQuestion(live(s), 'q');
    expect(result).toMatchObject({ status: 'unavailable', error: 'live_budget_exhausted' });
    expect(result.attempts.map((a) => [a.model, a.outcome])).toEqual([
      ['m1', 'http_error'],
      ['m2', 'budget'],
    ]);
  });

  describe('query embedding fallback', () => {
    const failingEmbed = (): Promise<readonly number[]> => Promise.reject(new Error('HTTP 503 embeddings'));
    const ftsHits = [chunk(7, 'https://x.test/docs/x#a', 0, null), chunk(8, 'https://x.test/docs/y', 0, null), chunk(9, 'https://x.test/docs/x#b', 1, null)];

    it('uses full-text articles when the embedding fails (retrieval_fallback fts)', async () => {
      let gen: ReturnType<typeof client> | undefined;
      const s = setup((t) => [(gen = client('m1', t, [{ text: reply() }]))], { embedQuery: failingEmbed, searchFullText: () => Promise.resolve(ftsHits) });
      const result = await answerQuestion(live(s), 'q');
      expect(result).toMatchObject({ status: 'unavailable', retrievalFallback: 'fts', answeredBy: null, handoffOffered: true });
      expect(result.articles.map((a) => a.url)).toEqual(['https://x.test/docs/x', 'https://x.test/docs/y']);
      expect(result.error).toMatch(/^embedding_unavailable/);
      expect(gen?.calls).toBe(0);
    });

    it('returns the fixed message without articles when full-text finds nothing (retrieval_fallback none)', async () => {
      const s = setup((t) => [client('m1', t, [])], { embedQuery: failingEmbed, searchFullText: () => Promise.resolve([]) });
      const result = await answerQuestion(live(s), '¿cómo cancelo?');
      expect(result).toMatchObject({ status: 'unavailable', retrievalFallback: 'none', articles: [] });
      expect(result.answer).toContain('Inténtalo de nuevo en un momento');
    });

    it('passes the remaining budget to the embedding and keeps retrieval_fallback vector on success', async () => {
      const seen: (number | undefined)[] = [];
      const s = setup((t) => [client('m1', t, [{ text: reply() }])], {
        embedQuery: (_q, opts) => {
          seen.push(opts.timeoutMs);
          return Promise.resolve([1, 0]);
        },
      });
      const result = await answerQuestion(live(s), 'q');
      expect(seen).toEqual([8000]);
      expect(result).toMatchObject({ status: 'answered', retrievalFallback: 'vector' });
    });
  });
});
