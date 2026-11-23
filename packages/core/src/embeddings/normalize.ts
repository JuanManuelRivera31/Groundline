/**
 * L2-normalizes a vector. gemini-embedding-001 only returns normalized vectors
 * at its default 3072 dimensions; reduced dimensions (e.g. 768) must be
 * normalized by the client (https://aistudio.google.com/docs/embeddings).
 */
export function l2Normalize(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Cannot normalize a zero or non-finite vector.');
  return vector.map((value) => value / norm);
}
