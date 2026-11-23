import { mulberry32 } from '@groundline/core';

export interface Interval {
  readonly value: number;
  readonly lo: number;
  readonly hi: number;
}

/**
 * Wilson score interval for a binomial proportion (default 95%, z = 1.959964).
 * Better behaved than the normal approximation for small n and extreme p.
 */
export function wilson(successes: number, n: number, z = 1.959964): Interval {
  if (n === 0) return { value: 0, lo: 0, hi: 0 };
  if (successes < 0 || successes > n) throw new Error('successes must be within [0, n]');
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { value: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/**
 * Area under the ROC curve of `score` separating positives from negatives,
 * via Mann-Whitney U: P(score_pos > score_neg) + 0.5 * P(tie).
 */
export function auc(positives: readonly number[], negatives: readonly number[]): number {
  if (positives.length === 0 || negatives.length === 0) return Number.NaN;
  // O((n+m) log(n+m)) with average ranks for ties.
  const all = [
    ...positives.map((score) => ({ score, pos: true })),
    ...negatives.map((score) => ({ score, pos: false })),
  ].sort((a, b) => a.score - b.score);
  let rankSumPos = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j]?.score === all[i]?.score) j++;
    const avgRank = (i + 1 + j) / 2; // ranks i+1..j
    for (let t = i; t < j; t++) if (all[t]?.pos) rankSumPos += avgRank;
    i = j;
  }
  const n = positives.length;
  const m = negatives.length;
  return (rankSumPos - (n * (n + 1)) / 2) / (n * m);
}

export interface BootstrapOptions {
  readonly resamples?: number;
  readonly seed?: number;
  /** Two-sided confidence level, default 0.95. */
  readonly level?: number;
}

/**
 * Percentile bootstrap CI for the AUC, resampling positives and negatives
 * separately (stratified) with replacement. Deterministic for a seed.
 */
export function bootstrapAuc(positives: readonly number[], negatives: readonly number[], options: BootstrapOptions = {}): Interval {
  const value = auc(positives, negatives);
  if (Number.isNaN(value)) return { value, lo: Number.NaN, hi: Number.NaN };
  const resamples = options.resamples ?? 2000;
  const level = options.level ?? 0.95;
  const random = mulberry32(options.seed ?? 20261123);
  const draw = (values: readonly number[]): number[] =>
    Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)] ?? 0);
  const samples: number[] = [];
  for (let r = 0; r < resamples; r++) samples.push(auc(draw(positives), draw(negatives)));
  samples.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return { value, lo: quantile(samples, alpha), hi: quantile(samples, 1 - alpha) };
}

/** Linear-interpolated quantile of an ascending array (type 7, as R/NumPy default). */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[hi] ?? Number.NaN;
  return a + (b - a) * (pos - lo);
}

export interface Distribution {
  readonly n: number;
  readonly min: number;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly max: number;
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/** Removes the `#anchor` part of a URL (document-level matching). */
export function stripAnchor(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

export type MatchLevel = 'document' | 'section';

/** 1-based rank of the first retrieved URL matching any expected URL, or null. */
export function firstHitRank(retrievedUrls: readonly string[], expectedUrls: readonly string[], level: MatchLevel): number | null {
  const normalize = level === 'document' ? stripAnchor : (url: string) => url;
  const expected = new Set(expectedUrls.map(normalize));
  const index = retrievedUrls.findIndex((url) => expected.has(normalize(url)));
  return index === -1 ? null : index + 1;
}

export interface RankMetrics {
  readonly n: number;
  /** recall@k with Wilson 95% interval and hit count. */
  readonly recall: Readonly<Record<string, Interval & { readonly hits: number }>>;
  /** Mean reciprocal rank within the retrieved list (0 when no hit). */
  readonly mrr: number;
}

export function rankMetrics(firstHitRanks: readonly (number | null)[], ks: readonly number[]): RankMetrics {
  const n = firstHitRanks.length;
  const recall: Record<string, Interval & { hits: number }> = {};
  for (const k of ks) {
    const hits = firstHitRanks.filter((rank) => rank !== null && rank <= k).length;
    recall[String(k)] = { ...wilson(hits, n), hits };
  }
  const mrr = n === 0 ? 0 : firstHitRanks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / n;
  return { n, recall, mrr };
}
