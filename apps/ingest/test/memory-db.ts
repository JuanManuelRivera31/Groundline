import type {
  ApiUsageInput,
  CachedEmbeddingRow,
  ChunkInput,
  Db,
  DocumentInput,
  IngestRunFinish,
  IngestRunStart,
  SearchHit,
  SourceInput,
  SyncDocument,
  SyncStats,
} from '@groundline/db';

interface StoredDocument extends DocumentInput {
  readonly id: number;
  chunks: ChunkInput[];
}

/** In-memory Db used to test the ingestion pipeline without Postgres. */
export class MemoryDb implements Db {
  readonly sources = new Map<string, { id: number; source: SourceInput }>();
  readonly documents = new Map<string, StoredDocument>();
  readonly cache = new Map<string, CachedEmbeddingRow>();
  readonly usage: (ApiUsageInput & { ts: Date })[] = [];
  readonly runs = new Map<number, IngestRunStart & Partial<IngestRunFinish>>();
  columnDims: number | null = 8;
  #nextId = 1;

  upsertSource(source: SourceInput): Promise<number> {
    const existing = this.sources.get(source.key);
    const id = existing?.id ?? this.#nextId++;
    this.sources.set(source.key, { id, source });
    return Promise.resolve(id);
  }

  syncSource(_sourceId: number, documents: readonly SyncDocument[]): Promise<SyncStats> {
    const stats = { documentsInserted: 0, documentsUpdated: 0, documentsDeleted: 0, chunksInserted: 0, chunksUpdated: 0, chunksUnchanged: 0, chunksDeleted: 0 };
    const seen = new Set<string>();
    for (const { document, chunks } of documents) {
      seen.add(document.path);
      const stored = this.documents.get(document.path);
      if (!stored) {
        this.documents.set(document.path, { ...document, id: this.#nextId++, chunks: [...chunks] });
        stats.documentsInserted++;
        stats.chunksInserted += chunks.length;
        continue;
      }
      if (stored.contentHash !== document.contentHash) stats.documentsUpdated++;
      chunks.forEach((chunk, i) => {
        const old = stored.chunks[i];
        if (!old) stats.chunksInserted++;
        else if (old.contentHash !== chunk.contentHash || old.url !== chunk.url || old.embeddingModel !== chunk.embeddingModel) stats.chunksUpdated++;
        else stats.chunksUnchanged++;
      });
      stats.chunksDeleted += Math.max(0, stored.chunks.length - chunks.length);
      this.documents.set(document.path, { ...document, id: stored.id, chunks: [...chunks] });
    }
    for (const [path, doc] of this.documents) {
      if (!seen.has(path)) {
        stats.documentsDeleted++;
        stats.chunksDeleted += doc.chunks.length;
        this.documents.delete(path);
      }
    }
    return Promise.resolve(stats);
  }

  getCachedEmbeddings(keys: readonly string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    for (const key of keys) {
      const row = this.cache.get(key);
      if (row) out.set(key, [...row.vector]);
    }
    return Promise.resolve(out);
  }

  putCachedEmbeddings(entries: readonly CachedEmbeddingRow[]): Promise<void> {
    for (const entry of entries) if (!this.cache.has(entry.key)) this.cache.set(entry.key, entry);
    return Promise.resolve();
  }

  recordApiUsage(usage: ApiUsageInput): Promise<void> {
    this.usage.push({ ...usage, ts: new Date() });
    return Promise.resolve();
  }

  sumApiRequestsSince(since: Date, model: string): Promise<number> {
    return Promise.resolve(
      this.usage.filter((u) => u.ts >= since && u.model === model).reduce((sum, u) => sum + u.requests, 0),
    );
  }

  startIngestRun(run: IngestRunStart): Promise<number> {
    const id = this.#nextId++;
    this.runs.set(id, { ...run });
    return Promise.resolve(id);
  }

  finishIngestRun(id: number, result: IngestRunFinish): Promise<void> {
    const run = this.runs.get(id);
    if (run) this.runs.set(id, { ...run, ...result });
    return Promise.resolve();
  }

  embeddingColumnDimensions(): Promise<number | null> {
    return Promise.resolve(this.columnDims);
  }

  searchVector(): Promise<SearchHit[]> {
    return Promise.resolve([]);
  }

  searchFullText(): Promise<SearchHit[]> {
    return Promise.resolve([]);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
