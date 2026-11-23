import type { AnswerSource, RetrievedChunk } from './types.ts';

/**
 * Groups ranked chunks by citation URL (anchor included) so a section split
 * into several chunks takes a single source slot. Groups keep the rank of
 * their best chunk; chunks inside a group are joined in document order.
 */
export function groupSources(ranked: readonly RetrievedChunk[], maxSources: number): AnswerSource[] {
  const groups = new Map<string, RetrievedChunk[]>();
  for (const chunk of ranked) {
    const group = groups.get(chunk.url);
    if (group) {
      if (!group.some((c) => c.chunkId === chunk.chunkId)) group.push(chunk);
    } else {
      if (groups.size >= maxSources) continue;
      groups.set(chunk.url, [chunk]);
    }
  }
  return [...groups.values()].map((chunks, i) => {
    const ordered = [...chunks].sort((a, b) => a.ord - b.ord);
    const first = ordered[0] ?? chunks[0];
    if (!first) throw new Error('Empty source group.');
    const sims = chunks.map((c) => c.cosine).filter((c): c is number => c !== null);
    return {
      id: `S${i + 1}`,
      title: first.documentTitle,
      headingPath: first.headingPath,
      url: first.url,
      text: ordered.map((c) => c.content.trim()).join('\n\n'),
      similarity: sims.length > 0 ? Math.max(...sims) : null,
      chunkIds: ordered.map((c) => c.chunkId),
    };
  });
}

/** Highest cosine among the retrieved chunks; 0 when there are none. */
export function maxSimilarity(ranked: readonly RetrievedChunk[]): number {
  let best = 0;
  for (const chunk of ranked) if (chunk.cosine !== null && chunk.cosine > best) best = chunk.cosine;
  return best;
}
