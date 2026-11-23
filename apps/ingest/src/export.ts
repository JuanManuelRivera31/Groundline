import { sha256Hex } from '@groundline/core';
import type { Corpus } from './corpus.ts';

/** One line of data/eval-work/chunks.jsonl. */
export interface ExportedChunk {
  /** Stable while the corpus commit and the chunker are unchanged; changes if the chunk text changes. */
  readonly id: string;
  readonly doc_path: string;
  readonly doc_title: string;
  readonly heading_path: string;
  /** Citation URL including `#anchor` when present. */
  readonly url: string;
  readonly content: string;
  readonly tokens: number;
}

/** `c_` + first 16 hex chars of sha256(doc path, ord, content hash). */
export async function chunkId(docPath: string, ord: number, contentHash: string): Promise<string> {
  return `c_${(await sha256Hex(`${docPath}\n${String(ord)}\n${contentHash}`)).slice(0, 16)}`;
}

export async function exportChunks(corpus: Corpus): Promise<ExportedChunk[]> {
  const rows: ExportedChunk[] = [];
  for (const doc of corpus.documents) {
    for (const chunk of doc.chunks) {
      rows.push({
        id: await chunkId(doc.path, chunk.ord, chunk.contentHash),
        doc_path: doc.path,
        doc_title: doc.title,
        heading_path: chunk.headingPath,
        url: chunk.url,
        content: chunk.content,
        tokens: chunk.tokens,
      });
    }
  }
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error('Chunk id collision in export.');
  return rows;
}

export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}
