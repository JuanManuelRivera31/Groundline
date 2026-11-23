export interface RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 6, baseDelayMs: 2_000, maxDelayMs: 120_000 };

/**
 * Exponential backoff with "equal jitter": half the exponential delay is fixed,
 * half random. Never shorter than the server-suggested delay.
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number, retryAfterMs?: number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const jittered = exponential / 2 + random() * (exponential / 2);
  return Math.ceil(Math.max(jittered, retryAfterMs ?? 0));
}
