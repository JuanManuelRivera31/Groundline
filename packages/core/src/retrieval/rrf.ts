/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009):
 * score(d) = Σ over lists of 1 / (k + rank_list(d)), with 1-based ranks.
 * Pure and runtime-agnostic: the database only supplies the candidate lists.
 */

export interface RankedItem {
  readonly chunkId: string | number;
  /** The list's own score (cosine for vector search, ts_rank_cd for full-text). */
  readonly score: number;
  /** Cosine similarity to the query, when known. */
  readonly cosine?: number | null | undefined;
}

export interface RankedList<T extends RankedItem> {
  readonly name: string;
  /** Best first. */
  readonly items: readonly T[];
}

export interface FusedItem<T extends RankedItem> {
  readonly chunkId: string | number;
  /** First occurrence across lists (in list order), for display fields. */
  readonly item: T;
  readonly rrfScore: number;
  /** 1-based rank in each list where the chunk appears. */
  readonly ranks: Readonly<Record<string, number>>;
  /** The list's own score in each list where the chunk appears. */
  readonly scores: Readonly<Record<string, number>>;
  readonly cosine: number | null;
}

export interface RrfOptions {
  /** Damping constant; larger values flatten the contribution of top ranks. Default 60. */
  readonly k?: number;
  /** Number of fused results to return. Default 8. */
  readonly limit?: number;
}

export const DEFAULT_RRF_K = 60;

export function fuseRrf<T extends RankedItem>(lists: readonly RankedList<T>[], options: RrfOptions = {}): FusedItem<T>[] {
  const k = options.k ?? DEFAULT_RRF_K;
  const limit = options.limit ?? 8;
  if (!(k >= 0)) throw new Error('RRF k must be a non-negative number.');

  interface Acc {
    chunkId: string | number;
    item: T;
    rrfScore: number;
    ranks: Record<string, number>;
    scores: Record<string, number>;
    cosine: number | null;
    bestRank: number;
  }
  const byId = new Map<string, Acc>();

  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const item of list.items) {
      const key = String(item.chunkId);
      if (seen.has(key)) continue; // a duplicate inside one list keeps its best rank only
      seen.add(key);
      rank++;
      let acc = byId.get(key);
      if (!acc) {
        acc = { chunkId: item.chunkId, item, rrfScore: 0, ranks: {}, scores: {}, cosine: null, bestRank: Infinity };
        byId.set(key, acc);
      }
      acc.rrfScore += 1 / (k + rank);
      acc.ranks[list.name] = rank;
      acc.scores[list.name] = item.score;
      acc.bestRank = Math.min(acc.bestRank, rank);
      if (acc.cosine === null && typeof item.cosine === 'number') acc.cosine = item.cosine;
    }
  }

  return [...byId.values()]
    .sort(
      (a, b) =>
        b.rrfScore - a.rrfScore ||
        a.bestRank - b.bestRank ||
        Object.keys(b.ranks).length - Object.keys(a.ranks).length ||
        String(a.chunkId).localeCompare(String(b.chunkId)),
    )
    .slice(0, limit)
    .map(({ bestRank: _bestRank, ...rest }) => rest);
}
