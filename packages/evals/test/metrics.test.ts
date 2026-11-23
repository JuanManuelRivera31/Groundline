import { describe, expect, it } from 'vitest';
import { auc, bootstrapAuc, distribution, firstHitRank, quantile, rankMetrics, stripAnchor, wilson } from '../src/metrics.ts';

describe('wilson', () => {
  it('matches known 95% intervals', () => {
    const w = wilson(8, 10);
    expect(w.value).toBe(0.8);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
    const zero = wilson(0, 20);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeCloseTo(0.1611, 3);
    const all = wilson(20, 20);
    expect(all.hi).toBe(1);
    expect(all.lo).toBeCloseTo(0.8389, 3);
  });

  it('handles n = 0 and rejects impossible counts', () => {
    expect(wilson(0, 0)).toEqual({ value: 0, lo: 0, hi: 0 });
    expect(() => wilson(5, 4)).toThrow();
  });
});

describe('auc', () => {
  it('is 1 for perfectly separated scores, 0 when inverted, 0.5 for identical', () => {
    expect(auc([0.9, 0.8, 0.7], [0.1, 0.2])).toBe(1);
    expect(auc([0.1, 0.2], [0.9, 0.8])).toBe(0);
    expect(auc([0.5, 0.5], [0.5, 0.5, 0.5])).toBe(0.5);
  });

  it('counts ties as one half (Mann-Whitney)', () => {
    // pairs: (0.6>0.4)=1, (0.6=0.6)=0.5, (0.3<0.4)=0, (0.3<0.6)=0 -> 1.5/4
    expect(auc([0.6, 0.3], [0.4, 0.6])).toBeCloseTo(0.375, 12);
  });

  it('is NaN when a class is empty', () => {
    expect(auc([], [0.1])).toBeNaN();
  });
});

describe('bootstrapAuc', () => {
  const pos = [0.71, 0.74, 0.69, 0.8, 0.66, 0.77, 0.72, 0.75];
  const neg = [0.6, 0.62, 0.7, 0.58];

  it('is deterministic for a seed and brackets the point estimate', () => {
    const a = bootstrapAuc(pos, neg, { resamples: 500, seed: 7 });
    const b = bootstrapAuc(pos, neg, { resamples: 500, seed: 7 });
    expect(a).toEqual(b);
    expect(a.value).toBe(auc(pos, neg));
    expect(a.lo).toBeLessThanOrEqual(a.value);
    expect(a.hi).toBeGreaterThanOrEqual(a.value);
    expect(a.hi).toBeLessThanOrEqual(1);
  });

  it('collapses to the point when separation is perfect', () => {
    expect(bootstrapAuc([0.9, 0.8], [0.1, 0.2], { resamples: 200 })).toEqual({ value: 1, lo: 1, hi: 1 });
  });
});

describe('quantile / distribution', () => {
  it('uses linear interpolation (type 7)', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(distribution([3, 1, 2])).toEqual({ n: 3, min: 1, p25: 1.5, median: 2, p75: 2.5, max: 3 });
    expect(distribution([]).n).toBe(0);
  });
});

describe('ranking metrics', () => {
  const expected = ['https://x.test/docs/billing#refunds'];
  it('matches at section level exactly and at document level without the anchor', () => {
    const retrieved = ['https://x.test/docs/plans', 'https://x.test/docs/billing#invoices', 'https://x.test/docs/billing#refunds'];
    expect(firstHitRank(retrieved, expected, 'section')).toBe(3);
    expect(firstHitRank(retrieved, expected, 'document')).toBe(2);
    expect(firstHitRank(['https://x.test/docs/plans'], expected, 'document')).toBeNull();
    expect(stripAnchor('https://x.test/a#b')).toBe('https://x.test/a');
  });

  it('computes recall@k with Wilson intervals and MRR', () => {
    const m = rankMetrics([1, 3, null, 8], [1, 3, 5, 8]);
    expect(m.n).toBe(4);
    expect(m.recall['1']?.hits).toBe(1);
    expect(m.recall['3']?.hits).toBe(2);
    expect(m.recall['5']?.hits).toBe(2);
    expect(m.recall['8']?.value).toBe(0.75);
    expect(m.recall['8']?.lo).toBeCloseTo(wilson(3, 4).lo, 12);
    expect(m.mrr).toBeCloseTo((1 + 1 / 3 + 0 + 1 / 8) / 4, 12);
    expect(rankMetrics([], [1]).mrr).toBe(0);
  });
});
