import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKED_COUNTRIES, isRegionBlocked, normalizeCountry } from '../src/region.ts';
import { hashIp } from '../src/crypto.ts';
import { answeredReply, harness, IP_SECRET, json, MODELS, TRIAL_TEXT, TRIAL_URL } from './harness.ts';

const Q = 'How long is the free trial?';
const START = Date.UTC(2026, 10, 26, 10, 0, 0);

describe('per-IP rate limit', () => {
  it('allows 3 questions per minute, then 429 with Retry-After until the window frees', async () => {
    const h = harness({ start: START });
    h.seedFor('unrelated', TRIAL_URL, 'Free trial', TRIAL_TEXT);
    for (let i = 0; i < 3; i++) {
      expect((await h.ask({ question: `question ${i}` })).status).toBe(200);
      h.advance(10_000);
    }
    const limited = await h.ask({ question: 'fourth' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect((await json(limited)).error).toMatchObject({ code: 'rate_limited', retry_after_sec: 30 });
    // Another IP is not affected.
    expect((await h.ask({ question: 'other ip' }, { 'x-test-ip': '203.0.113.9' })).status).toBe(200);
    h.advance(30_001);
    expect((await h.ask({ question: 'fifth' })).status).toBe(200);
  });

  it('allows 15 questions per UTC day, then 429 until midnight UTC', async () => {
    const h = harness({ start: START });
    h.seedFor('unrelated', TRIAL_URL, 'Free trial', TRIAL_TEXT);
    for (let i = 0; i < 15; i++) {
      expect((await h.ask({ question: `q${i}` })).status, `q${i}`).toBe(200);
      h.advance(61_000);
    }
    const limited = await h.ask({ question: 'sixteenth', lang: 'es' });
    expect(limited.status).toBe(429);
    const err = (await json(limited)).error as { message: string; retry_after_sec: number };
    expect(err.message).toContain('límite de preguntas de hoy');
    expect(err.retry_after_sec).toBe(Math.ceil((Date.UTC(2026, 10, 27) - h.now()) / 1000));
    h.advance(Date.UTC(2026, 10, 27, 0, 0, 1) - h.now());
    expect((await h.ask({ question: 'next day' })).status).toBe(200);
  });

  it('never stores the IP: only a daily-salted hash that changes every UTC day', async () => {
    const h = harness({ start: START });
    h.seedFor('unrelated', TRIAL_URL, 'Free trial', TRIAL_TEXT);
    await h.ask({ question: 'hello' }, { 'x-test-ip': '198.51.100.7' });
    const stored = JSON.stringify([...h.store.demoRequests, ...h.store.conversations.values()]);
    expect(stored).not.toContain('198.51.100.7');
    expect(h.store.demoRequests[0]?.ipHash).toBe(await hashIp(IP_SECRET, '198.51.100.7', START));
    expect(await hashIp(IP_SECRET, '198.51.100.7', START + 86_400_000)).not.toBe(await hashIp(IP_SECRET, '198.51.100.7', START));
    expect(await hashIp('another-secret-of-sufficient-length-000', '198.51.100.7', START)).not.toBe(await hashIp(IP_SECRET, '198.51.100.7', START));
  });
});

describe('regional block', () => {
  it('blocks the EEA, Switzerland and the UK without calling Gemini and keeps no question', async () => {
    for (const country of ['DE', 'ES', 'NO', 'IS', 'LI', 'CH', 'GB']) {
      const h = harness({ replies: { 'gen-a': [answeredReply()] } });
      h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
      const body = await json(await h.ask({ question: Q }, { 'x-test-country': country }));
      expect(body.status, country).toBe('region_blocked');
      expect(String(body.answer)).toContain('European Economic Area');
      expect(h.generation.get('gen-a')?.requests).toHaveLength(0);
      expect(h.embedding.calls).toHaveLength(0);
      const row = h.store.conversations.get(String(body.conversation_id));
      expect(row).toMatchObject({ status: 'region_blocked', questionRedacted: null, country });
    }
  });

  it('answers in Spanish for a Spanish question', async () => {
    const h = harness();
    const body = await json(await h.ask({ question: '¿Cuánto dura la prueba gratis?' }, { 'x-test-country': 'ES' }));
    expect(String(body.answer)).toContain('Espacio Económico Europeo');
  });

  it('lets other countries through and, on Workers, blocks an unknown country (fail-closed)', async () => {
    const us = harness({ replies: { 'gen-a': [answeredReply()] } });
    us.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    expect((await json(await us.ask({ question: Q }, { 'x-test-country': 'US' }))).status).toBe('answered');

    const nodeLocal = harness({ replies: { 'gen-a': [answeredReply()] } });
    nodeLocal.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    expect((await json(await nodeLocal.ask({ question: Q }))).status).toBe('answered');

    const workers = harness({ runtime: 'workers' });
    for (const country of [undefined, 'XX', 'T1']) {
      const headers: Record<string, string> = country ? { 'x-test-country': country } : {};
      expect((await json(await workers.ask({ question: Q }, headers))).status, String(country)).toBe('region_blocked');
    }
  });

  it('covers every EEA state, CH and GB in the default list', () => {
    const eea = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO'];
    for (const c of [...eea, 'CH', 'GB']) expect(DEFAULT_BLOCKED_COUNTRIES).toContain(c);
    expect(normalizeCountry(' de ')).toBe('DE');
    expect(normalizeCountry('T1')).toBeNull();
    expect(isRegionBlocked(null, new Set(['DE']), false)).toBe(false);
    expect(isRegionBlocked(null, new Set(['DE']), true)).toBe(true);
  });

  it('honours a custom BLOCKED_COUNTRIES list', async () => {
    const h = harness({ env: { BLOCKED_COUNTRIES: 'BR, ar' } });
    expect((await json(await h.ask({ question: Q }, { 'x-test-country': 'AR' }))).status).toBe('region_blocked');
  });
});

describe('daily generation budget', () => {
  const spend = (h: ReturnType<typeof harness>, model: string, requests: number): void => {
    h.store.usage.push({ kind: 'generate', model, requests, estTokens: 0, httpStatus: 200, ts: new Date() });
  };

  it('skips a model whose 150 requests are spent and answers with the next one', async () => {
    const h = harness({ replies: { 'gen-a': [answeredReply()], 'gen-b': [answeredReply()] } });
    h.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    spend(h, 'gen-a', 150);
    const body = await json(await h.ask({ question: Q }));
    expect(body.status).toBe('answered');
    expect(h.generation.get('gen-a')?.requests).toHaveLength(0);
    expect(h.store.conversations.get(String(body.conversation_id))?.answeredBy).toBe('gen-b');
  });

  it('switches to articles-only (no Gemini call at all) when every chain model is at the cap', async () => {
    const h = harness();
    h.seedFor('unrelated vector', TRIAL_URL, 'Free trial', TRIAL_TEXT);
    for (const m of MODELS) spend(h, m, 150);
    const body = await json(await h.ask({ question: 'how long does the free trial last' }));
    expect(body.status).toBe('articles_only');
    expect(String(body.answer)).toContain('daily limit of AI answers');
    expect(body.articles).toEqual([{ title: 'Free trial', url: 'https://docs.test/billing/trial' }]);
    expect(body.handoff_offered).toBe(true);
    expect(h.embedding.calls).toHaveLength(0);
    for (const m of MODELS) expect(h.generation.get(m)?.requests).toHaveLength(0);
    expect(h.store.usage).toHaveLength(2);
  });

  it('uses a cached query embedding for articles-only when there is one', async () => {
    // Warm the cache with one normal answer, then spend the budget.
    const warm = harness({ replies: { 'gen-a': [answeredReply()] } });
    warm.seedFor(Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    await warm.ask({ question: Q });
    for (const m of MODELS) spend(warm, m, 150);
    const body = await json(await warm.ask({ question: Q }, { 'x-test-ip': '203.0.113.20' }));
    expect(body.status).toBe('articles_only');
    const row = warm.store.conversations.get(String(body.conversation_id));
    expect(row?.error).toBe('demo_daily_cap');
    expect(row?.maxSimilarity).toBeCloseTo(1, 6);
    expect(warm.embedding.calls).toHaveLength(1);
  });

  it('never raises the cap above the configured RPD', async () => {
    const h = harness({ env: { DEMO_DAILY_GEN_CAP: '500' }, engine: { GEN_RPD: '10' } });
    h.seedFor('unrelated vector', TRIAL_URL, 'Free trial', TRIAL_TEXT);
    for (const m of MODELS) spend(h, m, 10);
    expect((await json(await h.ask({ question: 'free trial' }))).status).toBe('articles_only');
  });
});

describe('personal data', () => {
  const PII_Q = 'My email is jane.doe@example.com and my phone is +1 (555) 123-4567, card 4111 1111 1111 1111, IP 203.0.113.42. How long is the free trial?';
  const REDACTED_Q = 'My email is [redacted] and my phone is [redacted], card [redacted], IP [redacted]. How long is the free trial?';

  it('redacts before the model, before embedding and before storage; logs carry no customer text', async () => {
    const h = harness({ replies: { 'gen-a': [answeredReply()] } });
    h.seedFor(REDACTED_Q, TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const body = await json(await h.ask({ question: PII_Q }, { 'x-test-ip': '192.0.2.55' }));
    expect(body.status).toBe('answered');

    const sent = JSON.stringify(h.generation.get('gen-a')?.requests);
    for (const secret of ['jane.doe@example.com', '555', '4111', '203.0.113.42']) expect(sent).not.toContain(secret);
    expect(sent).toContain('[redacted]');
    expect(JSON.stringify(h.embedding.calls)).not.toContain('jane.doe');

    const row = h.store.conversations.get(String(body.conversation_id));
    expect(row?.questionRedacted).toBe(REDACTED_Q);

    const logs = h.logs.join('\n');
    for (const secret of ['jane.doe', '555', '4111', '203.0.113.42', '192.0.2.55', 'free trial']) expect(logs).not.toContain(secret);
    expect(logs).toContain('"redacted_spans":4');
  });

  it('redacts Spanish personal data too', async () => {
    const h = harness();
    h.seedFor('unrelated', TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const body = await json(await h.ask({ question: 'Hola, soy juan@ejemplo.es, mi móvil es +34 612 34 56 78. ¿Cuánto dura la prueba?' }));
    expect(h.store.conversations.get(String(body.conversation_id))?.questionRedacted).toBe('Hola, soy [redacted], mi móvil es [redacted]. ¿Cuánto dura la prueba?');
  });

  it('does not log the question or echo it when a request fails', async () => {
    const h = harness();
    h.store.searchVector = () => Promise.reject(new Error('boom: SELECT ... jane.doe@example.com'));
    h.seedFor('x', TRIAL_URL, 'Free trial', TRIAL_TEXT);
    const res = await h.ask({ question: 'secret question from jane.doe@example.com' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('jane');
    expect(h.logs.join('\n')).not.toContain('jane');
    expect(h.logs.join('\n')).toContain('"error":"Error"');
  });
});
