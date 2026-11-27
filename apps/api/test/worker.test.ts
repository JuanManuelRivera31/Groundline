import { describe, expect, it } from 'vitest';
import worker from '../src/worker.ts';
import { IP_SECRET } from './harness.ts';

/** Collects waitUntil promises like the Workers runtime does. */
function executionContext() {
  const tasks: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException: () => undefined, props: {} }, settle: () => Promise.allSettled(tasks) };
}

// Port 1 on loopback refuses at once: the DB is "down" without any network access.
const DOWN_DB = 'postgres://u:p@127.0.0.1:1/none';

describe('Workers entry point', () => {
  it('refuses to start without IP_HASH_SECRET and says nothing about the reason to the client', async () => {
    const { ctx } = executionContext();
    const res = await worker.fetch(new Request('https://api.test/v1/health'), { DATABASE_URL: DOWN_DB }, ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'misconfigured', message: 'The service is not configured.' } });
  });

  it('serves the shared app with a per-request ClientDb and closes it through waitUntil', async () => {
    const { ctx, settle } = executionContext();
    const env = { IP_HASH_SECRET: IP_SECRET, DATABASE_URL: DOWN_DB };
    const res = await worker.fetch(new Request('https://api.test/v1/health'), env, ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', db: 'error' });
    await settle();
  });

  it('validates the body before touching the database', async () => {
    const { ctx, settle } = executionContext();
    const env = { IP_HASH_SECRET: IP_SECRET, DATABASE_URL: DOWN_DB };
    const req = new Request('https://api.test/v1/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question": 7}' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
    await settle();
  });

  it('runs retention from the scheduled handler and logs a failure instead of throwing', async () => {
    const { ctx, settle } = executionContext();
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      worker.scheduled({}, { IP_HASH_SECRET: IP_SECRET, DATABASE_URL: DOWN_DB }, ctx);
      await settle();
    } finally {
      console.log = original;
    }
    expect(lines.some((l) => l.includes('"event":"retention_failed"'))).toBe(true);
  });
});
