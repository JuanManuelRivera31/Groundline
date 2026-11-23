import { describe, expect, it } from 'vitest';
import { QuotaExceededError, RateLimiter } from '../src/ratelimit/limiter.ts';
import { nextPacificDayStart, pacificDayStart } from '../src/time.ts';
import { fakeTime } from './helpers.ts';

const limits = { rpm: 60, tpm: 20_000, rpd: 800 };

describe('RateLimiter', () => {
  it('lets requests through immediately while under the limits', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits, clock: t.clock, sleep: t.sleep });
    await limiter.acquire({ requests: 20, tokens: 5_000 });
    await limiter.acquire({ requests: 20, tokens: 5_000 });
    expect(t.sleeps).toEqual([]);
    expect(limiter.usedToday).toBe(40);
  });

  it('waits for the RPM window (a batch of N counts as N requests)', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits, clock: t.clock, sleep: t.sleep });
    await limiter.acquire({ requests: 40, tokens: 100 });
    t.advance(10_000);
    await limiter.acquire({ requests: 40, tokens: 100 });
    // The first event (40 requests) must leave the 60 s window: 50 s from now.
    expect(t.sleeps).toEqual([50_000]);
  });

  it('waits for the TPM window', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits, clock: t.clock, sleep: t.sleep });
    await limiter.acquire({ requests: 1, tokens: 15_000 });
    t.advance(30_000);
    await limiter.acquire({ requests: 1, tokens: 10_000 });
    expect(t.sleeps).toEqual([30_000]);
  });

  it('frees only as many old events as needed', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits: { rpm: 3, tpm: 1_000, rpd: 100 }, clock: t.clock, sleep: t.sleep });
    await limiter.acquire({ requests: 1, tokens: 1 });
    t.advance(1_000);
    await limiter.acquire({ requests: 1, tokens: 1 });
    t.advance(1_000);
    await limiter.acquire({ requests: 1, tokens: 1 });
    await limiter.acquire({ requests: 1, tokens: 1 });
    expect(t.sleeps).toEqual([58_000]);
  });

  it('fails fast when the daily quota would be exceeded, counting usage from before startup', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits, clock: t.clock, sleep: t.sleep, usedToday: 790 });
    await limiter.acquire({ requests: 10, tokens: 10 });
    await expect(limiter.acquire({ requests: 1, tokens: 10 })).rejects.toBeInstanceOf(QuotaExceededError);
    expect(limiter.remainingToday).toBe(0);
  });

  it('resets the daily count at midnight Pacific time', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits, clock: t.clock, sleep: t.sleep, usedToday: 800 });
    await expect(limiter.acquire({ requests: 1, tokens: 1 })).rejects.toBeInstanceOf(QuotaExceededError);
    t.advance(nextPacificDayStart(t.clock.now()) - t.clock.now());
    await limiter.acquire({ requests: 1, tokens: 1 });
    expect(limiter.usedToday).toBe(1);
  });

  it('rejects a single call larger than RPM or TPM instead of waiting forever', async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ limits, clock: t.clock, sleep: t.sleep });
    await expect(limiter.acquire({ requests: 61, tokens: 1 })).rejects.toThrow(/RPM/);
    await expect(limiter.acquire({ requests: 1, tokens: 20_001 })).rejects.toThrow(/TPM/);
  });
});

describe('pacificDayStart', () => {
  it('returns local midnight in America/Los_Angeles (PST, UTC-8)', () => {
    // 2026-11-22 18:00 UTC = 10:00 PST.
    expect(new Date(pacificDayStart(Date.UTC(2026, 10, 22, 18, 0, 0))).toISOString()).toBe('2026-11-22T08:00:00.000Z');
  });

  it('handles PDT (UTC-7) and times just after midnight', () => {
    expect(new Date(pacificDayStart(Date.UTC(2026, 6, 1, 7, 30, 0))).toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(new Date(pacificDayStart(Date.UTC(2026, 6, 1, 6, 59, 59))).toISOString()).toBe('2026-06-30T07:00:00.000Z');
  });

  it('handles DST transition days', () => {
    // 2026-03-08 (spring forward) and 2026-11-01 (fall back), evening local time.
    expect(new Date(pacificDayStart(Date.UTC(2026, 2, 9, 3, 0, 0))).toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(new Date(pacificDayStart(Date.UTC(2026, 10, 2, 5, 0, 0))).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(new Date(nextPacificDayStart(Date.UTC(2026, 10, 1, 12, 0, 0))).toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });
});
