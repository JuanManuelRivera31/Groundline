import { describe, expect, it } from 'vitest';
import { answeredReply, GOALS_TEXT, GOALS_URL, harness, json, TRIAL_TEXT, TRIAL_URL } from './harness.ts';

const Q = 'How long is the free trial?';

describe('POST /v1/ask', () => {
  it('returns a cited answer with numbered sources and records the conversation', async () => {
    const h = harness({ replies: { 'gen-a': [answeredReply()] } });
    h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const res = await h.ask({ question: Q });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      status: 'answered',
      answer: 'The free trial lasts 30 days [1].',
      sources: [{ n: 1, title: 'Free trial', url: TRIAL_URL, quotes: ['The free trial lasts 30 days'] }],
      articles: [],
      handoff_offered: false,
      lang: 'en',
    });
    const id = String(body.conversation_id);
    const row = h.store.conversations.get(id);
    expect(row).toMatchObject({ status: 'answered', answeredBy: 'gen-a', questionRedacted: Q, country: null, nearestUrl: TRIAL_URL, generationRequests: 1 });
    expect(row?.costUsd).toBeNull(); // fake model ids have no list price
    expect(h.generation.get('gen-a')?.requests).toHaveLength(1);
  });

  it('answers "insufficient" below the floor without calling the model', async () => {
    const h = harness();
    h.seedFor('something unrelated entirely', GOALS_URL, 'Goals', GOALS_TEXT);
    const body = await json(await h.ask({ question: 'Can I pay with bitcoin?' }));
    expect(body.status).toBe('insufficient');
    expect(body.handoff_offered).toBe(true);
    expect(h.generation.get('gen-a')?.requests).toHaveLength(0);
    const row = h.store.conversations.get(String(body.conversation_id));
    expect(row?.floorHit).toBe(true);
  });

  it('falls back to the next chain model, then to "unavailable" with articles', async () => {
    const h = harness({ replies: { 'gen-a': [new Error('socket hang up')], 'gen-b': [answeredReply()] } });
    h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const first = await json(await h.ask({ question: Q }));
    expect(first.status).toBe('answered');
    expect(h.store.conversations.get(String(first.conversation_id))?.answeredBy).toBe('gen-b');

    const down = harness({ replies: { 'gen-a': [new Error('down')], 'gen-b': [new Error('down')] } });
    down.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const body = await json(await down.ask({ question: Q }));
    expect(body.status).toBe('unavailable');
    expect(body.articles).toEqual([{ title: 'Free trial', url: 'https://docs.test/billing/trial' }]);
    expect(body.handoff_offered).toBe(true);
  });

  it('validates the body: JSON object, string question, not empty, at most 500 characters', async () => {
    const h = harness();
    const bad = await h.request('/v1/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toMatchObject({ code: 'invalid_json' });
    expect((await h.ask({ question: 42 })).status).toBe(400);
    expect((await h.ask({ question: '   ' })).status).toBe(400);
    expect((await h.ask({ question: 'x', lang: 3 })).status).toBe(400);

    const long = await h.ask({ question: 'a'.repeat(501) });
    expect(long.status).toBe(400);
    expect((await json(long)).error).toMatchObject({ code: 'question_too_long', max_chars: 500 });
    // 500 code points pass, even when they are 2 UTF-16 units each; no request was counted for the rejected ones.
    h.seedFor('ñ'.repeat(500), TRIAL_URL, 'Free trial', TRIAL_TEXT);
    expect((await h.ask({ question: '😀'.repeat(500) })).status).toBe(200);
    expect(h.store.demoRequests).toHaveLength(1);
  });

  it('rejects bodies over 8 KB', async () => {
    const h = harness();
    const res = await h.request('/v1/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '9000' }, body: JSON.stringify({ question: 'x'.repeat(9000) }) });
    expect(res.status).toBe(413);
  });

  it('uses lang for its own fixed messages', async () => {
    const h = harness();
    const res = await h.ask({ question: 'a'.repeat(501), lang: 'es-MX' });
    expect(((await json(res)).error as { message: string }).message).toContain('demasiado larga');
  });
});

describe('GET /v1/health', () => {
  it('reports the database state', async () => {
    const h = harness();
    expect(await json(await h.request('/v1/health'))).toEqual({ status: 'ok', db: 'ok' });
    h.store.pingFails = true;
    const res = await h.request('/v1/health');
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ status: 'degraded', db: 'error' });
  });

  it('answers unknown routes with a JSON 404', async () => {
    const h = harness();
    const res = await h.request('/v1/nope');
    expect(res.status).toBe(404);
    expect((await json(res)).error).toMatchObject({ code: 'not_found' });
  });
});

describe('CORS', () => {
  it('allows only the configured origins', async () => {
    const h = harness();
    const pre = await h.request('/v1/ask', { method: 'OPTIONS', headers: { origin: 'https://demo.test', 'access-control-request-method': 'POST' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://demo.test');

    const foreign = await h.request('/v1/ask', { method: 'OPTIONS', headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    const post = await h.ask({ question: Q }, { origin: 'https://evil.test' });
    expect(post.status).toBe(403);
    expect(h.store.demoRequests).toHaveLength(0);

    h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const allowed = await h.ask({ question: Q }, { origin: 'https://demo.test' });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://demo.test');
  });
});
