import { backoffDelayMs, type RetryPolicy } from '../embeddings/retry.ts';
import { GeminiApiError } from '../gemini/http.ts';
import type { Acquisition, Clock, RateLimiterLike, Sleep } from './limiter.ts';

export interface RetryCallDeps {
  readonly limiter: RateLimiterLike;
  readonly retry: RetryPolicy;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly clock: Clock;
}

/** One HTTP attempt, successful or not, for usage recording. */
export interface AttemptInfo<T> {
  readonly attempt: number;
  /** HTTP status: 200 on success, the error status otherwise (0 for network/unknown errors). */
  readonly status: number;
  readonly durationMs: number;
  readonly result?: T | undefined;
}

export interface RetryCallResult<T> {
  readonly result: T;
  readonly attempts: number;
  /** Time spent waiting for the limiter (not counted as latency). */
  readonly queueWaitMs: number;
  /** Time spent in HTTP calls and backoff sleeps. */
  readonly callMs: number;
}

/**
 * Runs `fn` through the rate limiter, retrying retryable Gemini errors (429,
 * 5xx, network) with the same backoff as embeddings. Every attempt is
 * reported through `onAttempt` before the next one starts.
 */
export async function callWithRetry<T>(
  deps: RetryCallDeps,
  cost: Acquisition,
  fn: () => Promise<T>,
  onAttempt: (info: AttemptInfo<T>) => Promise<void>,
): Promise<RetryCallResult<T>> {
  let queueWaitMs = 0;
  let callMs = 0;
  for (let attempt = 0; ; attempt++) {
    const queued = deps.clock.now();
    await deps.limiter.acquire(cost);
    const started = deps.clock.now();
    queueWaitMs += started - queued;
    try {
      const result = await fn();
      const durationMs = deps.clock.now() - started;
      callMs += durationMs;
      await onAttempt({ attempt, status: 200, durationMs, result });
      return { result, attempts: attempt + 1, queueWaitMs, callMs };
    } catch (error) {
      const durationMs = deps.clock.now() - started;
      callMs += durationMs;
      const status = error instanceof GeminiApiError ? error.status : 0;
      await onAttempt({ attempt, status, durationMs });
      if (!(error instanceof GeminiApiError) || !error.retryable || attempt >= deps.retry.maxRetries) throw error;
      const wait = backoffDelayMs(attempt, deps.retry, deps.random, error.retryAfterMs);
      await deps.sleep(wait);
      callMs += wait;
    }
  }
}
