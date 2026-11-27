import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { runRetention } from '../src/app.ts';
import { parseApiConfig } from '../src/config.ts';
import { hmacSha256Hex } from '../src/crypto.ts';
import { groupGaps, normalizeQuestion } from '../src/admin.ts';
import type { WebhookFetch } from '../src/handoff.ts';
import { ADMIN_TOKEN, answeredReply, apiEnv, GOALS_TEXT, GOALS_URL, harness, json, TRIAL_TEXT, TRIAL_URL } from './harness.ts';

const Q = 'How long is the free trial?';
const HOOK_URL = 'https://hooks.client.test/groundline';
const HOOK_SECRET = 'webhook-signing-secret';

/** A fake receiver: a Hono app reached through an injected fetch, so no socket is opened. */
function fakeWebhookServer(status = 200) {
  const received: { headers: Record<string, string>; body: string }[] = [];
  const server = new Hono();
  server.post('/groundline', async (c) => {
    received.push({ headers: Object.fromEntries(c.req.raw.headers), body: await c.req.text() });
    return c.text('ok', status as 200);
  });
  const fetchFn: WebhookFetch = async (url, init) => server.request(url, init);
  return { received, fetchFn };
}

async function conversation(h: ReturnType<typeof harness>, question = Q): Promise<string> {
  const body = await json(await h.ask({ question }));
  return String(body.conversation_id);
}

const post = (h: ReturnType<typeof harness>, body: unknown) =>
  h.request('/v1/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /v1/handoff', () => {
  it('records a case without asking for personal data; in the demo nobody is notified', async () => {
    const h = harness({ replies: { 'gen-a': [answeredReply()] } });
    h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const id = await conversation(h);
    const res = await post(h, { conversation_id: id, note: 'Please call me at +34 612 34 56 78' });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ conversation_id: id, notified: false });
    expect(String(body.message)).toContain('demo');
    const stored = [...h.store.handoffs.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ deliveryStatus: 'not_configured', noteRedacted: 'Please call me at [redacted]' });

    // Idempotent: one case per conversation.
    const again = await post(h, { conversation_id: id });
    expect(again.status).toBe(200);
    expect((await json(again)).handoff_id).toBe(body.handoff_id);
    expect(h.store.handoffs.size).toBe(1);
  });

  it('validates the request and answers 404 for an unknown conversation', async () => {
    const h = harness();
    expect((await post(h, { conversation_id: 'nope' })).status).toBe(400);
    expect((await post(h, { conversation_id: '00000000-0000-4000-8000-999999999999' })).status).toBe(404);
    const id = await conversation(h);
    expect((await post(h, { conversation_id: id, note: 'x'.repeat(501) })).status).toBe(400);
    expect((await post(h, { conversation_id: id, note: 7 })).status).toBe(400);
  });

  it('delivers a signed JSON payload to HANDOFF_WEBHOOK_URL', async () => {
    const hook = fakeWebhookServer();
    const h = harness({ env: { HANDOFF_WEBHOOK_URL: HOOK_URL, HANDOFF_WEBHOOK_SECRET: HOOK_SECRET }, webhookFetch: hook.fetchFn, replies: { 'gen-a': [answeredReply()] } });
    h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const id = await conversation(h);
    const res = await post(h, { conversation_id: id, note: 'mail me at jane@example.com' });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ notified: true });
    expect(hook.received).toHaveLength(1);
    const { headers, body } = hook.received[0] ?? { headers: {}, body: '' };
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: 'groundline.handoff', conversation_id: id, question: Q, bot_status: 'answered', note: 'mail me at [redacted]' });
    expect(payload.sources).toEqual([{ title: 'Free trial', url: TRIAL_URL }]);
    const ts = headers['x-groundline-timestamp'] ?? '';
    expect(headers['x-groundline-signature']).toBe(`sha256=${await hmacSha256Hex(HOOK_SECRET, `${ts}.${body}`)}`);
    expect([...h.store.handoffs.values()][0]).toMatchObject({ deliveryStatus: 'delivered' });
    expect(body).not.toContain('jane@');
  });

  it('sends a Slack-style {text} body when HANDOFF_WEBHOOK_FORMAT=slack', async () => {
    const hook = fakeWebhookServer();
    const h = harness({ env: { HANDOFF_WEBHOOK_URL: HOOK_URL, HANDOFF_WEBHOOK_FORMAT: 'slack' }, webhookFetch: hook.fetchFn });
    const id = await conversation(h, 'Can I pay with bitcoin?');
    await post(h, { conversation_id: id });
    const body = JSON.parse(hook.received[0]?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['text']);
    expect(String(body.text)).toContain('*Question:* Can I pay with bitcoin?');
    expect(hook.received[0]?.headers['x-groundline-signature']).toBeUndefined();
  });

  it('records a failed delivery (HTTP error or timeout) without failing the request', async () => {
    const hook = fakeWebhookServer(500);
    const h = harness({ env: { HANDOFF_WEBHOOK_URL: HOOK_URL }, webhookFetch: hook.fetchFn });
    const res = await post(h, { conversation_id: await conversation(h) });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ notified: false });
    expect([...h.store.handoffs.values()][0]?.deliveryStatus).toBe('failed: http 500');

    const hanging: WebhookFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(init.signal?.reason as Error); });
      });
    const slow = harness({ env: { HANDOFF_WEBHOOK_URL: HOOK_URL, HANDOFF_WEBHOOK_TIMEOUT_MS: '100' }, webhookFetch: hanging });
    await post(slow, { conversation_id: await conversation(slow) });
    expect([...slow.store.handoffs.values()][0]?.deliveryStatus).toBe('failed: timeout');
  });

  it('refuses a non-https webhook URL', () => {
    expect(() => parseApiConfig(apiEnv({ HANDOFF_WEBHOOK_URL: 'http://hooks.client.test/x' }), 'node')).toThrow(/https/);
    expect(parseApiConfig(apiEnv({ HANDOFF_WEBHOOK_URL: 'http://localhost:9000/x' }), 'node').handoffWebhook?.url).toBe('http://localhost:9000/x');
  });
});

describe('admin API', () => {
  const admin = (h: ReturnType<typeof harness>, path: string, token: string | null = ADMIN_TOKEN) =>
    h.request(path, token === null ? {} : { headers: { authorization: `Bearer ${token}` } });

  it('requires the admin token and is absent when no token is configured', async () => {
    const h = harness();
    expect((await admin(h, '/v1/admin/conversations', null)).status).toBe(401);
    expect((await admin(h, '/v1/admin/conversations', `${ADMIN_TOKEN}x`)).status).toBe(401);
    expect((await admin(h, '/v1/admin/conversations')).status).toBe(200);
    const off = harness({ env: { ADMIN_TOKEN: '' } });
    expect((await admin(off, '/v1/admin/conversations')).status).toBe(404);
    expect(() => parseApiConfig(apiEnv({ ADMIN_TOKEN: 'short' }), 'node')).toThrow(/32/);
    expect(h.logs.join('\n')).not.toContain(ADMIN_TOKEN);
  });

  it('lists conversations (filter, pagination) and shows one', async () => {
    const h = harness({ replies: { 'gen-a': [answeredReply()] } });
    h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const answered = await conversation(h);
    h.advance(1000);
    await conversation(h, 'Can I pay with bitcoin?');
    const all = await json(await admin(h, '/v1/admin/conversations?limit=1'));
    expect((all.items as unknown[]).length).toBe(1);
    expect(all.next_before).not.toBeNull();
    const filtered = await json(await admin(h, '/v1/admin/conversations?status=answered'));
    expect((filtered.items as { id: string }[]).map((i) => i.id)).toEqual([answered]);
    const one = await json(await admin(h, `/v1/admin/conversations/${answered}`));
    expect(one).toMatchObject({ id: answered, status: 'answered', question: Q, answered_by: 'gen-a' });
    expect((await admin(h, '/v1/admin/conversations?status=weird')).status).toBe(400);
    expect((await admin(h, '/v1/admin/conversations/00000000-0000-4000-8000-999999999999')).status).toBe(404);
  });

  it('lists hand-off cases with their conversation', async () => {
    const h = harness();
    const id = await conversation(h, 'Can I pay with bitcoin?');
    await post(h, { conversation_id: id });
    const body = await json(await admin(h, '/v1/admin/handoffs'));
    expect(body.items).toEqual([expect.objectContaining({ conversation_id: id, question: 'Can I pay with bitcoin?', bot_status: 'insufficient', delivery_status: 'not_configured' })]);
  });

  it('groups "I don\'t know" questions by nearest document in the gap report', async () => {
    const h = harness();
    h.seedFor('unrelated', GOALS_URL, 'Goals', GOALS_TEXT);
    await conversation(h, 'Can I pay with bitcoin?');
    await conversation(h, 'can i pay with Bitcoin');
    await conversation(h, 'Do you have a mobile app?');
    const body = await json(await admin(h, '/v1/admin/gaps?days=7'));
    expect(body.questions).toBe(3);
    const groups = body.groups as { document_url: string; count: number; questions: { text: string; count: number }[] }[];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ document_url: GOALS_URL, count: 3 });
    expect(groups[0]?.questions.map((q) => q.count)).toEqual([2, 1]);
    expect((await admin(h, '/v1/admin/gaps?days=400')).status).toBe(400);
  });

  it('reports cost and availability per day', async () => {
    const h = harness({ replies: { 'gen-a': [answeredReply(), new Error('down')], 'gen-b': [new Error('down')] } });
    h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    await conversation(h);
    await conversation(h);
    await conversation(h, 'Can I pay with bitcoin?');
    const body = await json(await admin(h, '/v1/admin/daily?days=1'));
    const days = body.days as Record<string, unknown>[];
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ conversations: 3, model_eligible: 2, unavailable: 1, availability: 0.5, by_status: { answered: 1, unavailable: 1, insufficient: 1 } });
    expect((body.api_usage as { model: string }[]).map((u) => u.model).sort()).toEqual(['fake-embedding', 'gen-a', 'gen-b']);
  });

  it('gap and pure helpers normalize and sort', () => {
    expect(normalizeQuestion('  ¿Cómo   EXCLUYO mi IP?? ')).toBe('cómo excluyo mi ip');
    const at = new Date('2026-11-26T10:00:00Z');
    const groups = groupGaps([
      { questionRedacted: 'a?', nearestUrl: 'https://d/x#h', nearestTitle: 'X', maxSimilarity: 0.5, createdAt: at },
      { questionRedacted: 'b', nearestUrl: null, nearestTitle: null, maxSimilarity: null, createdAt: at },
      { questionRedacted: 'A', nearestUrl: 'https://d/x', nearestTitle: 'X', maxSimilarity: 0.7, createdAt: at },
    ]);
    expect(groups.map((g) => [g.document_url, g.count])).toEqual([
      ['https://d/x', 2],
      [null, 1],
    ]);
    expect(groups[0]?.questions[0]).toMatchObject({ count: 2, max_similarity: 0.7 });
  });
});

describe('retention', () => {
  it('deletes conversations older than 30 days with their cases, and rate-limit events older than 2 days', async () => {
    const start = Date.UTC(2026, 9, 1);
    const h = harness({ start });
    const old = await conversation(h, 'Can I pay with bitcoin?');
    await post(h, { conversation_id: old });
    h.advance(31 * 86_400_000);
    const fresh = await conversation(h, 'Do you have a mobile app?');
    const result = await runRetention(h.store, h.config, h.now());
    expect(result).toEqual({ conversations: 1, handoffs: 1, rateLimitEvents: 1 });
    expect([...h.store.conversations.keys()]).toEqual([fresh]);
  });

});
