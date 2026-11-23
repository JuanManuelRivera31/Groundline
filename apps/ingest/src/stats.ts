import type { Corpus, CorpusChunk } from './corpus.ts';

export interface ChunkQualityStats {
  readonly documents: number;
  readonly chunks: number;
  readonly tokens: { readonly min: number; readonly median: number; readonly p95: number; readonly max: number };
  readonly under60Tokens: number;
  readonly topDocuments: readonly { readonly path: string; readonly chunks: number }[];
}

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

export function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

export function chunkQualityStats(corpus: Corpus, topN = 5): ChunkQualityStats {
  const tokens = corpus.documents.flatMap((doc) => doc.chunks.map((chunk) => chunk.tokens)).sort((a, b) => a - b);
  const topDocuments = corpus.documents
    .map((doc) => ({ path: doc.path, chunks: doc.chunks.length }))
    .sort((a, b) => b.chunks - a.chunks || a.path.localeCompare(b.path))
    .slice(0, topN);
  return {
    documents: corpus.documents.length,
    chunks: tokens.length,
    tokens: { min: tokens[0] ?? 0, median: median(tokens), p95: percentile(tokens, 95), max: tokens[tokens.length - 1] ?? 0 },
    under60Tokens: tokens.filter((t) => t < 60).length,
    topDocuments,
  };
}

/** Deterministic PRNG so samples are reproducible with --seed (shared with evals). */
export { mulberry32 } from '@groundline/core';

export function sampleChunks(corpus: Corpus, count: number, random: () => number): CorpusChunk[] {
  const all = corpus.documents.flatMap((doc) => doc.chunks);
  const picked = new Set<number>();
  while (picked.size < Math.min(count, all.length)) picked.add(Math.floor(random() * all.length));
  return [...picked].map((i) => all[i]).filter((chunk): chunk is CorpusChunk => chunk !== undefined);
}
