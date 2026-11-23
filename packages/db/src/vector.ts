/** pgvector text format: "[0.1,0.2,...]". */
export function toVectorLiteral(vector: readonly number[]): string {
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('Vector contains a non-finite value.');
  }
  return `[${vector.join(',')}]`;
}

export function parseVectorLiteral(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) throw new Error('Not a pgvector literal.');
  const inner = trimmed.slice(1, -1).trim();
  return inner === '' ? [] : inner.split(',').map(Number);
}
