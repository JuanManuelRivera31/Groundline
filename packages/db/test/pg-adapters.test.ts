import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../src/api-types.ts';
import { PgDb } from '../src/node/pg-db.ts';
import { ClientDb } from '../src/workers/client-db.ts';
import { PG_TEST_URL, temporarySchema } from './pg-schema.ts';

const unit = (i: number): number[] => Array.from({ length: 768 }, (_, k) => (k === i ? 1 : 0));

const conversation = (id: string, over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id,
  createdAt: new Date('2026-11-26T10:00:00Z'),
  questionRedacted: 'How do I add a goal?',
  lang: 'en',
  status: 'answered',
  answer: 'Use the goals page [1].',
  sources: [{ n: 1, title: 'Goals', url: 'https://docs.test/goals#add', quotes: ['Add a goal from the settings'] }],
  articles: [],
  handoffOffered: false,
  answeredBy: 'gemini-3.5-flash-lite',
  floorHit: false,
  hedged: false,
  nearestUrl: 'https://docs.test/goals#add',
  nearestTitle: 'Goals',
  maxSimilarity: 0.81,
  latencyMs: 1200,
  generationRequests: 1,
  promptTokens: 1000,
  outputTokens: 100,
  thoughtsTokens: 0,
  costUsd: 0.0015,
  country: 'US',
  error: null,
  ...over,
});

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!PG_TEST_URL)('Postgres adapters against the local database (pnpm test:db)', () => {
  let schema: { url: string; drop: () => Promise<void> };

  beforeAll(async () => {
    schema = await temporarySchema(PG_TEST_URL ?? '', 'test_db');
  });

  afterAll(async () => {
    await schema.drop();
  });

  it('ClientDb connects lazily, runs the shared SQL and closes (also when never used)', async () => {
    await new ClientDb(schema.url).close();

    const db = new ClientDb(schema.url);
    try {
      const sourceId = await db.upsertSource({ key: 'demo', name: 'Demo', repoUrl: 'https://x.test/repo', baseUrl: 'https://docs.test', license: null, pinnedCommit: 'abc' });
      const stats = await db.syncSource(sourceId, [
        {
          document: { path: 'goals.md', url: 'https://docs.test/goals', title: 'Goals', contentHash: 'h1', commitSha: 'abc' },
          chunks: [
            { ord: 0, headingPath: 'Goals > Add', anchor: 'add', url: 'https://docs.test/goals#add', content: 'Add a goal from the settings page.', tokens: 8, contentHash: 'c1', embedding: unit(0), embeddingModel: 'm' },
            { ord: 1, headingPath: 'Goals > Delete', anchor: 'delete', url: 'https://docs.test/goals#delete', content: 'Delete a goal with the trash icon.', tokens: 8, contentHash: 'c2', embedding: unit(1), embeddingModel: 'm' },
          ],
        },
      ]);
      expect(stats.chunksInserted).toBe(2);
      expect(await db.embeddingColumnDimensions()).toBe(768);
      const hits = await db.searchVector(unit(1), 'm', 2);
      expect(hits.map((h) => h.url)).toEqual(['https://docs.test/goals#delete', 'https://docs.test/goals#add']);
      expect(hits[0]?.score).toBeCloseTo(1, 6);
      expect((await db.searchFullText('how do I delete a goal', 5))[0]?.url).toBe('https://docs.test/goals#delete');
      await db.putCachedEmbeddings([{ key: 'k1', model: 'm', dimensions: 768, taskType: 'RETRIEVAL_QUERY', vector: unit(3) }]);
      expect((await db.getCachedEmbeddings(['k1'])).get('k1')?.[3]).toBe(1);
      await db.recordApiUsage({ kind: 'generate', model: 'gen', requests: 1, estTokens: 10, httpStatus: 200, promptTokens: 5, outputTokens: 2 });
      expect(await db.sumApiRequestsSince(new Date(Date.now() - 60_000), 'gen')).toBe(1);
      await db.ping();
    } finally {
      await db.close();
    }
    await expect(db.ping()).rejects.toThrow(/closed/);
  });

  it('rate limit counts the last minute and the UTC day, and serializes concurrent requests of one hash', async () => {
    const now = new Date('2026-11-26T10:00:00Z');
    const dayStart = new Date('2026-11-26T00:00:00Z');
    const req = (ms: number) => ({ ipHash: 'hash-a', now: new Date(now.getTime() + ms), perMinute: 3, perDay: 5, dayStart });
    // Five concurrent requests on five per-request clients: exactly 3 pass the minute window.
    const clients = Array.from({ length: 5 }, () => new ClientDb(schema.url));
    try {
      const results = await Promise.all(clients.map((c, i) => c.consumeRateLimit(req(i))));
      expect(results.filter((r) => r.allowed)).toHaveLength(3);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
    const db = new PgDb(schema.url);
    try {
      const blocked = await db.consumeRateLimit(req(10));
      expect(blocked).toMatchObject({ allowed: false, minuteCount: 3, dayCount: 3 });
      // The oldest of the three that won the race (at +0…+4 ms).
      expect((blocked.oldestInMinute?.getTime() ?? 0) - now.getTime()).toBeLessThan(5);
      expect((await db.consumeRateLimit(req(61_000))).allowed).toBe(true);
      expect((await db.consumeRateLimit(req(122_000))).allowed).toBe(true);
      const dayFull = await db.consumeRateLimit(req(183_000));
      expect(dayFull).toMatchObject({ allowed: false, dayCount: 5 });
      expect((await db.consumeRateLimit({ ...req(183_000), ipHash: 'hash-b' })).allowed).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('stores conversations and hand-off cases, and serves the admin views', async () => {
    const db = new ClientDb(schema.url);
    try {
      await db.insertConversation(conversation(uuid(1)));
      await db.insertConversation(
        conversation(uuid(2), {
          createdAt: new Date('2026-11-26T11:00:00Z'),
          status: 'insufficient',
          questionRedacted: 'Can I pay with [redacted]?',
          answer: "I couldn't find this.",
          sources: [],
          handoffOffered: true,
          latencyMs: 300,
          costUsd: null,
          floorHit: true,
        }),
      );
      await db.insertConversation(conversation(uuid(3), { createdAt: new Date('2026-11-26T12:00:00Z'), status: 'unavailable', latencyMs: 7500, costUsd: 0.0005 }));
      await db.insertConversation(conversation(uuid(4), { createdAt: new Date('2026-11-26T13:00:00Z'), status: 'region_blocked', questionRedacted: null, country: 'DE', latencyMs: 5 }));

      const got = await db.getConversation(uuid(1));
      expect(got).toEqual(conversation(uuid(1)));
      expect(await db.getConversation(uuid(99))).toBeNull();
      expect((await db.listConversations({ limit: 2 })).map((c) => c.id)).toEqual([uuid(4), uuid(3)]);
      expect((await db.listConversations({ limit: 10, before: new Date('2026-11-26T11:30:00Z') })).map((c) => c.id)).toEqual([uuid(2), uuid(1)]);
      expect((await db.listConversations({ limit: 10, status: 'insufficient' })).map((c) => c.id)).toEqual([uuid(2)]);

      const first = await db.insertHandoff({ id: uuid(50), conversationId: uuid(2), createdAt: new Date('2026-11-26T11:01:00Z'), noteRedacted: null, deliveryStatus: 'pending' });
      expect(first.created).toBe(true);
      const again = await db.insertHandoff({ id: uuid(51), conversationId: uuid(2), createdAt: new Date(), noteRedacted: 'x', deliveryStatus: 'pending' });
      expect(again).toMatchObject({ created: false, handoff: { id: uuid(50) } });
      await db.updateHandoffDelivery(uuid(50), 'delivered', new Date('2026-11-26T11:01:01Z'));
      const cases = await db.listHandoffs({ limit: 10 });
      expect(cases).toEqual([
        expect.objectContaining({ id: uuid(50), conversationId: uuid(2), deliveryStatus: 'delivered', questionRedacted: 'Can I pay with [redacted]?', status: 'insufficient' }),
      ]);

      const gaps = await db.gapRows({ since: new Date('2026-11-01T00:00:00Z'), limit: 10 });
      expect(gaps).toEqual([expect.objectContaining({ questionRedacted: 'Can I pay with [redacted]?', nearestTitle: 'Goals' })]);

      const daily = await db.dailyStats(new Date('2026-11-26T00:00:00Z'));
      expect(daily.conversations).toHaveLength(1);
      expect(daily.conversations[0]).toMatchObject({
        day: '2026-11-26',
        total: 4,
        byStatus: { answered: 1, insufficient: 1, unavailable: 1, region_blocked: 1 },
        modelEligible: 2,
        unavailable: 1,
        latencyP50Ms: 1200,
        promptTokens: 4000,
      });
      expect(daily.conversations[0]?.costUsd).toBeCloseTo(0.0035, 9);
      expect(daily.conversations[0]?.latencyP95Ms).toBeGreaterThan(6000);
      expect(daily.apiUsage.some((u) => u.model === 'gen' && u.requests === 1 && u.failed === 0)).toBe(true);

      const purged = await db.purgeExpired({ conversationsBefore: new Date('2026-11-26T11:30:00Z'), rateLimitBefore: new Date('2026-11-26T10:01:30Z') });
      expect(purged).toEqual({ conversations: 2, handoffs: 1, rateLimitEvents: 4 });
      expect((await db.listConversations({ limit: 10 })).map((c) => c.id)).toEqual([uuid(4), uuid(3)]);
    } finally {
      await db.close();
    }
  });
});
