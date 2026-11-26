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

/**
 * Virtual-time scheduler for concurrent code: `wait` registers a timer, and the
 * earliest timer fires (advancing the clock) only after every pending microtask
 * has run, so parallel calls interleave deterministically by simulated time.
 */
export function fakeScheduler(start = Date.UTC(2026, 10, 22, 18, 0, 0)): {
  clock: Clock;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  sleep: Sleep;
  /** An AbortSignal that aborts with a TimeoutError after `ms` of simulated time. */
  timeoutSignal: (ms: number) => AbortSignal;
} {
  let now = start;
  let seq = 0;
  let pumping = false;
  const timers: { at: number; seq: number; fire: () => void }[] = [];
  const pump = (): void => {
    pumping = false;
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const timer = timers.shift();
    if (!timer) return;
    now = Math.max(now, timer.at);
    timer.fire();
    schedule();
  };
  const schedule = (): void => {
    if (pumping || timers.length === 0) return;
    pumping = true;
    setTimeout(pump, 0);
  };
  const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = {
        at: now + Math.max(0, ms),
        seq: seq++,
        fire: (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timers.push(timer);
      schedule();
    });
  const timeoutSignal = (ms: number): AbortSignal => {
    const controller = new AbortController();
    void wait(ms).then(() => {
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    });
    return controller.signal;
  };
  return { clock: { now: () => now }, wait, sleep: (ms) => wait(ms), timeoutSignal };
}
