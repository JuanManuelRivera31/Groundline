import { FakeEmbeddingClient, FakeGenerationClient, parseConfig, type EnvRecord, type FakeReply } from '@groundline/core';
import { createApp, type ClientInfo } from '../src/app.ts';
import { parseApiConfig, type ApiRuntime } from '../src/config.ts';
import type { WebhookFetch } from '../src/handoff.ts';
import { jsonLogger } from '../src/logger.ts';
import { MemoryStore } from './memory-store.ts';

export const MODELS = ['gen-a', 'gen-b'] as const;
export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef-XYZ';
export const IP_SECRET = 'test-ip-hash-secret-0123456789abcdef-XYZ';
export const DIMS = 8;
export const EMBEDDING_MODEL = 'fake-embedding';

export const TRIAL_URL = 'https://docs.test/billing/trial#how-long';
export const TRIAL_TEXT = 'The free trial lasts 30 days and needs no credit card.';
export const GOALS_URL = 'https://docs.test/goals/custom-events';
export const GOALS_TEXT = 'Custom events are tracked with the plausible function and appear as goals in the dashboard.';

/** Engine settings of the tests: a fake two-model chain over 8-dimensional fake embeddings. */
export function engineEnv(over: EnvRecord = {}): EnvRecord {
  return {
    EMBEDDING_MODEL,
    EMBEDDING_DIMS: String(DIMS),
    GEN_MODELS: MODELS.join(','),
    GEN_RPM: '1000',
    GEN_TPM: '100000000',
    GEN_RPD: '200',
    HEDGE_AFTER_MS: '0',
    ...over,
  };
}

export function apiEnv(over: EnvRecord = {}): EnvRecord {
  return { IP_HASH_SECRET: IP_SECRET, ADMIN_TOKEN, CORS_ORIGINS: 'https://demo.test', ...over };
}

/** A v4 model answer that cites S1 with a verbatim quote. */
export function answeredReply(answer = 'The free trial lasts 30 days [S1].', quote = 'The free trial lasts 30 days'): FakeReply {
  return {
    text: JSON.stringify({
      status: 'answered',
      declined_injection: false,
      answer,
      citations: [{ source_id: 'S1', quote }],
      handoff_reason: '',
    }),
  };
}

export interface HarnessOptions {
  readonly runtime?: ApiRuntime;
  readonly env?: EnvRecord;
  readonly engine?: EnvRecord;
  /** Scripted replies per chain model. */
  readonly replies?: Partial<Record<(typeof MODELS)[number], FakeReply[]>>;
  readonly webhookFetch?: WebhookFetch;
  /** Simulated wall clock for the API layer (rate limits, timestamps). */
  readonly start?: number;
}

export function harness(options: HarnessOptions = {}) {
  const store = new MemoryStore();
  const logs: string[] = [];
  let now = options.start ?? Date.now();
  const generation = new Map<string, FakeGenerationClient>(MODELS.map((m) => [m, new FakeGenerationClient(options.replies?.[m] ?? [], m)]));
  const embedding = new FakeEmbeddingClient({ model: EMBEDDING_MODEL, dimensions: DIMS });
  const deferred: Promise<unknown>[] = [];
  let ids = 0;
  const config = parseApiConfig(apiEnv(options.env), options.runtime ?? 'node');
  const appConfig = parseConfig(engineEnv(options.engine));
  const app = createApp({
    config,
    appConfig,
    openStore: () => ({ store, close: () => Promise.resolve() }),
    clientInfo: (c): ClientInfo => ({ ip: c.req.header('x-test-ip') ?? '198.51.100.7', country: c.req.header('x-test-country') ?? null }),
    now: () => now,
    uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    webhookFetch: options.webhookFetch ?? (() => Promise.reject(new Error('no webhook in this test'))),
    logger: jsonLogger((line) => logs.push(line)),
    defer: (_c, task) => deferred.push(task),
    engineClients: {
      generation: (model) => {
        const client = generation.get(model);
        if (!client) throw new Error(`unexpected model ${model}`);
        return client;
      },
      embedding,
    },
  });

  /** Seeds one chunk whose embedding equals the query embedding of `question` (similarity 1). */
  const seedFor = (question: string, url: string, title: string, content: string): void => {
    store.chunks.push({
      chunkId: store.chunks.length + 1,
      ord: 0,
      url,
      headingPath: `${title} > Section`,
      documentTitle: title,
      content,
      embedding: FakeEmbeddingClient.vectorFor(`RETRIEVAL_QUERY:${question}`, DIMS),
      embeddingModel: EMBEDDING_MODEL,
    });
  };

  const ask = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request('/v1/ask', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    await Promise.all(deferred.splice(0));
    return res;
  };

  return {
    app,
    store,
    logs,
    generation,
    embedding,
    config,
    seedFor,
    ask,
    advance: (ms: number): void => {
      now += ms;
    },
    now: (): number => now,
    settle: () => Promise.all(deferred.splice(0)),
    request: async (path: string, init: RequestInit = {}) => {
      const res = await app.request(path, init);
      await Promise.all(deferred.splice(0));
      return res;
    },
  };
}

export const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;
