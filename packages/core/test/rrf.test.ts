import { describe, expect, it } from 'vitest';
import { mulberry32, shuffled } from '../src/random.ts';
import { fuseRrf, type RankedItem } from '../src/retrieval/rrf.ts';

const item = (chunkId: number, score: number, cosine?: number): RankedItem => ({ chunkId, score, cosine });

describe('fuseRrf', () => {
  it('sums 1/(k+rank) across lists and orders by fused score', () => {
    const fused = fuseRrf(
      [
        { name: 'vector', items: [item(1, 0.9, 0.9), item(2, 0.8, 0.8), item(3, 0.7, 0.7)] },
        { name: 'fts', items: [item(3, 2.0), item(4, 1.0)] },
      ],
      { k: 60, limit: 10 },
    );
    expect(fused.map((f) => f.chunkId)).toEqual([3, 1, 2, 4]);
    expect(fused[0]?.rrfScore).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[0]?.ranks).toEqual({ vector: 3, fts: 1 });
    expect(fused[0]?.scores).toEqual({ vector: 0.7, fts: 2.0 });
    expect(fused[0]?.cosine).toBe(0.7);
    expect(fused[3]).toMatchObject({ chunkId: 4, ranks: { fts: 2 }, cosine: null });
  });

  it('deduplicates chunks and respects the limit', () => {
    const fused = fuseRrf(
      [
        { name: 'vector', items: [item(1, 0.9), item(1, 0.5), item(2, 0.4)] },
        { name: 'fts', items: [item(2, 3), item(1, 2)] },
      ],
      { limit: 1 },
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]?.ranks).toEqual({ vector: 1, fts: 2 });
  });

  it('k changes how much the top rank dominates', () => {
    const lists = [
      { name: 'a', items: [item(1, 1), item(2, 1), item(3, 1)] },
      { name: 'b', items: [item(4, 1), item(3, 1), item(2, 1)] },
    ];
    // k = 0: a single first place (1.0) beats ranks 2 + 3 in both lists (0.83).
    expect(fuseRrf(lists, { k: 0, limit: 4 }).map((f) => f.chunkId)).toEqual([1, 4, 2, 3]);
    // Large k: appearing in both lists matters more than being first once.
    expect(fuseRrf(lists, { k: 1000, limit: 4 }).map((f) => f.chunkId)).toEqual([2, 3, 1, 4]);
  });

  it('breaks exact ties deterministically (best rank, list count, id)', () => {
    const fused = fuseRrf([
      { name: 'a', items: [item(7, 1)] },
      { name: 'b', items: [item(5, 1)] },
    ]);
    expect(fused.map((f) => f.chunkId)).toEqual([5, 7]);
  });

  it('handles empty and missing lists', () => {
    expect(fuseRrf([])).toEqual([]);
    expect(fuseRrf([{ name: 'fts', items: [] }, { name: 'vector', items: [item(1, 0.5, 0.5)] }]).map((f) => f.chunkId)).toEqual([1]);
    expect(() => fuseRrf([], { k: -1 })).toThrow();
  });
});

describe('mulberry32 / shuffled', () => {
  it('is deterministic for a seed and permutes without loss', () => {
    const a = shuffled([1, 2, 3, 4, 5, 6], mulberry32(42));
    const b = shuffled([1, 2, 3, 4, 5, 6], mulberry32(42));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(shuffled([1, 2, 3, 4, 5, 6], mulberry32(7))).not.toEqual(a);
  });
});
