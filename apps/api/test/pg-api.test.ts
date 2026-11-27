import { FakeEmbeddingClient, FakeGenerationClient, parseConfig } from '@groundline/core';
import { ClientDb } from '@groundline/db/workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { parseApiConfig } from '../src/config.ts';
import { jsonLogger } from '../src/logger.ts';
import { PG_TEST_URL, temporarySchema } from '../../../packages/db/test/pg-schema.ts';
import { ADMIN_TOKEN, answeredReply, apiEnv, engineEnv } from './harness.ts';

const DIMS = 768;
const Q = 'How long is the free trial?';

describe.skipIf(!PG_TEST_URL)('API on the local Postgres with a per-request ClientDb (pnpm test:db)', () => {
  let schema: { url: string; drop: () => Promise<void> };
  const opened: ClientDb[] = [];
  const closed: ClientDb[] = [];
  const deferred: Promise<unknown>[] = [];
  const gen = new FakeGenerationClient([answeredReply(), answeredReply()], 'gen-a');
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    schema = await temporarySchema(PG_TEST_URL ?? '', 'test_api');
    const seed = new ClientDb(schema.url);
    try {
      const sourceId = await seed.upsertSource({ key: 'demo', name: 'Demo', repoUrl: 'https://x.test/r', baseUrl: 'https://docs.test', license: null, pinnedCommit: 'abc' });
      await seed.syncSource(sourceId, [
        {
          document: { path: 'trial.md', url: 'https://docs.test/trial', title: 'Free trial', contentHash: 'h', commitSha: 'abc' },
          chunks: [
            {
              ord: 0,
              headingPath: 'Free trial > Length',
              anchor: 'length',
              url: 'https://docs.test/trial#length',
              content: 'The free trial lasts 30 days and needs no credit card.',
              tokens: 12,
              contentHash: 'c',
              embedding: FakeEmbeddingClient.vectorFor(`RETRIEVAL_QUERY:${Q}`, DIMS),
              embeddingModel: 'fake-embedding',
            },
          ],
        },
      ]);
    } finally {
      await seed.close();
    }
    app = createApp({
      config: parseApiConfig(apiEnv(), 'workers'),
      appConfig: parseConfig(engineEnv({ EMBEDDING_DIMS: String(DIMS) })),
      openStore: () => {
        const db = new ClientDb(schema.url);
        opened.push(db);
        return {
          store: db,
          close: async () => {
            await db.close();
            closed.push(db);
          },
        };
      },
      clientInfo: (c) => ({ ip: c.req.header('x-test-ip') ?? '198.51.100.7', country: c.req.header('x-test-country') ?? 'US' }),
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      webhookFetch: () => Promise.reject(new Error('no webhook')),
      logger: jsonLogger(() => undefined),
      defer: (_c, task) => deferred.push(task),
      engineClients: { generation: () => gen, embedding: new FakeEmbeddingClient({ model: 'fake-embedding', dimensions: DIMS }) },
    });
  });

  afterAll(async () => {
    await Promise.allSettled(deferred);
    await schema.drop();
  });

  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await app.request(path, init);
    await Promise.all(deferred.splice(0));
    return res;
  };
  const ask = (question: string, headers: Record<string, string> = {}) =>
    call('/v1/ask', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ question }) });

  it('answers, records the conversation, takes a hand-off and reports it to the admin API', async () => {
    const health = await call('/v1/health');
    expect(await health.json()).toEqual({ status: 'ok', db: 'ok' });

    const res = await ask(Q);
    const body = (await res.json()) as { status: string; conversation_id: string; sources: unknown[] };
    expect(body.status).toBe('answered');
    expect(body.sources).toHaveLength(1);

    const handoff = await call('/v1/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversation_id: body.conversation_id, note: 'call +1 555 123 4567' }) });
    expect(handoff.status).toBe(201);

    const auth = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };
    const one = (await (await call(`/v1/admin/conversations/${body.conversation_id}`, auth)).json()) as Record<string, unknown>;
    expect(one).toMatchObject({ status: 'answered', question: Q, answered_by: 'gen-a', country: 'US' });
    const cases = (await (await call('/v1/admin/handoffs', auth)).json()) as { items: { note: string }[] };
    expect(cases.items[0]?.note).toBe('call [redacted]');
    const daily = (await (await call('/v1/admin/daily?days=1', auth)).json()) as { days: { conversations: number }[]; api_usage: { model: string }[] };
    expect(daily.days[0]?.conversations).toBe(1);
    expect(daily.api_usage.map((u) => u.model).sort()).toEqual(['fake-embedding', 'gen-a']);

    // One client per request, each closed after its deferred work.
    expect(closed).toHaveLength(opened.length);
  });

  it('enforces the per-IP minute limit through Postgres and blocks the EEA without a model call', async () => {
    const ip = { 'x-test-ip': '203.0.113.77' };
    const before = gen.requests.length;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await ask('Can I pay with bitcoin?', ip)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);

    const blocked = (await (await ask(Q, { 'x-test-ip': '203.0.113.78', 'x-test-country': 'FR' })).json()) as { status: string };
    expect(blocked.status).toBe('region_blocked');
    expect(gen.requests.length).toBe(before);
  });
});
