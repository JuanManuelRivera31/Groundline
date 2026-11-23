import type { Clock, Sleep } from '../src/ratelimit/limiter.ts';

/** Simulated clock: sleeping advances time instantly and records each wait. */
export function fakeTime(start = Date.UTC(2026, 10, 22, 18, 0, 0)): { clock: Clock; sleep: Sleep; sleeps: number[]; advance: (ms: number) => void } {
  let now = start;
  const sleeps: number[] = [];
  return {
    clock: { now: () => now },
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    sleeps,
    advance: (ms) => {
      now += ms;
    },
  };
}
