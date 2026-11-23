import type { RateLimits } from '../config.ts';
import { nextPacificDayStart } from '../time.ts';

export interface Clock {
  now(): number;
}

export type Sleep = (ms: number) => Promise<void>;

export interface Acquisition {
  /** Quota units. A batch of N texts counts as N requests (worst case). */
  readonly requests: number;
  /** Estimated tokens, already including any safety factor. */
  readonly tokens: number;
}

export interface RateLimiterLike {
  acquire(cost: Acquisition): Promise<void>;
}

export interface RateLimiterOptions {
  readonly limits: RateLimits;
  readonly clock: Clock;
  readonly sleep: Sleep;
  /** Requests already spent today (since the last Pacific midnight), e.g. summed from api_usage. */
  readonly usedToday?: number;
  /** Returns the epoch ms at which the daily quota resets after `now`. */
  readonly nextDayStart?: (now: number) => number;
  readonly windowMs?: number;
}

export class QuotaExceededError extends Error {
  override readonly name = 'QuotaExceededError';
}

interface Event {
  readonly at: number;
  readonly requests: number;
  readonly tokens: number;
}

/**
 * Client-side limiter for RPM, TPM (sliding one-minute window) and RPD
 * (calendar day ending at midnight Pacific time). Waits for the minute window
 * to free up; fails fast when the daily quota would be exceeded, because
 * waiting for midnight is never the right behaviour for a CLI.
 */
export class RateLimiter implements RateLimiterLike {
  readonly #limits: RateLimits;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  readonly #windowMs: number;
  readonly #nextDayStart: (now: number) => number;
  #events: Event[] = [];
  #usedToday: number;
  #dayEndsAt: number;

  constructor(options: RateLimiterOptions) {
    this.#limits = options.limits;
    this.#clock = options.clock;
    this.#sleep = options.sleep;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#nextDayStart = options.nextDayStart ?? nextPacificDayStart;
    this.#usedToday = options.usedToday ?? 0;
    this.#dayEndsAt = this.#nextDayStart(this.#clock.now());
  }

  get usedToday(): number {
    this.#rollDay(this.#clock.now());
    return this.#usedToday;
  }

  get remainingToday(): number {
    return Math.max(0, this.#limits.rpd - this.usedToday);
  }

  async acquire(cost: Acquisition): Promise<void> {
    const { rpm, tpm, rpd } = this.#limits;
    if (cost.requests > rpm) {
      throw new QuotaExceededError(`A single call of ${cost.requests} requests exceeds the RPM limit (${rpm}).`);
    }
    if (cost.tokens > tpm) {
      throw new QuotaExceededError(`A single call of ~${cost.tokens} tokens exceeds the TPM limit (${tpm}).`);
    }

    for (;;) {
      const now = this.#clock.now();
      this.#rollDay(now);
      if (this.#usedToday + cost.requests > rpd) {
        throw new QuotaExceededError(
          `Daily quota would be exceeded: ${this.#usedToday} of ${rpd} requests used today (resets at midnight Pacific time).`,
        );
      }
      this.#events = this.#events.filter((event) => event.at > now - this.#windowMs);
      const wait = this.#waitMs(now, cost);
      if (wait <= 0) {
        this.#events.push({ at: now, requests: cost.requests, tokens: cost.tokens });
        this.#usedToday += cost.requests;
        return;
      }
      await this.#sleep(wait);
    }
  }

  #rollDay(now: number): void {
    if (now >= this.#dayEndsAt) {
      this.#usedToday = 0;
      this.#dayEndsAt = this.#nextDayStart(now);
    }
  }

  /** Milliseconds until the window has room for `cost`; 0 if it fits now. */
  #waitMs(now: number, cost: Acquisition): number {
    let requests = 0;
    let tokens = 0;
    for (const event of this.#events) {
      requests += event.requests;
      tokens += event.tokens;
    }
    const fits = (): boolean => requests + cost.requests <= this.#limits.rpm && tokens + cost.tokens <= this.#limits.tpm;
    if (fits()) return 0;
    for (const event of this.#events) {
      requests -= event.requests;
      tokens -= event.tokens;
      if (fits()) return event.at + this.#windowMs - now;
    }
    return this.#windowMs;
  }
}
