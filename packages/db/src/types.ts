/**
 * Data access contract. Runtime adapters (Node + Docker Postgres today,
 * Workers + Neon in the deployment session) implement this interface so the
 * rest of the kit never depends on a specific driver or connection lifecycle.
 */

export interface SourceInput {
  readonly key: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly baseUrl: string;
  readonly license: string | null;
  readonly pinnedCommit: string;
}

export interface DocumentInput {
  /** Path relative to the docs root, POSIX separators. */
  readonly path: string;
  readonly url: string;
  readonly title: string;
  readonly contentHash: string;
  readonly commitSha: string;
}

export interface ChunkInput {
  readonly ord: number;
  readonly headingPath: string;
  readonly anchor: string | null;
  /** Citation URL, including `#anchor` when present. */
  readonly url: string;
  readonly content: string;
  readonly tokens: number;
  readonly contentHash: string;
  readonly embedding: readonly number[];
  readonly embeddingModel: string;
}

export interface SyncDocument {
  readonly document: DocumentInput;
  readonly chunks: readonly ChunkInput[];
}

export interface SyncStats {
  readonly documentsInserted: number;
  readonly documentsUpdated: number;
  readonly documentsDeleted: number;
  readonly chunksInserted: number;
  readonly chunksUpdated: number;
  readonly chunksUnchanged: number;
  readonly chunksDeleted: number;
}

export interface CachedEmbeddingRow {
  readonly key: string;
  readonly model: string;
  readonly dimensions: number;
  readonly taskType: string;
  readonly vector: readonly number[];
}

export interface ApiUsageInput {
  readonly kind: string;
  readonly model: string;
  readonly requests: number;
  readonly estTokens: number;
  readonly httpStatus: number | null;
  readonly ingestRunId?: number | null | undefined;
  /** Real token counts (generation only). */
  readonly promptTokens?: number | null | undefined;
  readonly outputTokens?: number | null | undefined;
  readonly thoughtsTokens?: number | null | undefined;
  readonly latencyMs?: number | null | undefined;
}

export interface IngestRunStart {
  readonly sourceId: number;
  readonly commitSha: string;
  readonly embeddingModel: string;
  readonly embeddingDims: number;
}

export interface IngestRunFinish {
  readonly status: 'succeeded' | 'failed';
  readonly documents: number;
  readonly chunks: number;
  readonly tokens: number;
  readonly apiCalls: number;
  readonly apiRequests: number;
  readonly cacheHits: number;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

export interface SearchHit {
  readonly chunkId: number;
  /** Position of the chunk inside its document. */
  readonly ord: number;
  readonly score: number;
  readonly headingPath: string;
  readonly url: string;
  readonly content: string;
  readonly documentTitle: string;
}

export interface CandidateHit extends SearchHit {
  /** Cosine similarity to the query vector (also for full-text hits); null if the chunk has no embedding for the model. */
  readonly cosine: number | null;
}

export interface CandidateQuery {
  readonly query: string;
  readonly vector: readonly number[];
  readonly embeddingModel: string;
  /** Number of vector candidates. */
  readonly vectorK: number;
  /** Number of full-text candidates. */
  readonly ftsK: number;
}

/** Raw candidate lists for hybrid retrieval; fusion happens in packages/core. */
export interface CandidateLists {
  readonly vector: CandidateHit[];
  readonly fullText: CandidateHit[];
}

export interface Db {
  upsertSource(source: SourceInput): Promise<number>;
  /** Upserts all documents/chunks of a source and deletes stale ones, in one transaction. */
  syncSource(sourceId: number, documents: readonly SyncDocument[]): Promise<SyncStats>;

  getCachedEmbeddings(keys: readonly string[]): Promise<Map<string, number[]>>;
  putCachedEmbeddings(entries: readonly CachedEmbeddingRow[]): Promise<void>;

  recordApiUsage(usage: ApiUsageInput): Promise<void>;
  /** Sum of `requests` for a model since `since` (all kinds), for the daily quota. */
  sumApiRequestsSince(since: Date, model: string): Promise<number>;

  startIngestRun(run: IngestRunStart): Promise<number>;
  finishIngestRun(id: number, result: IngestRunFinish): Promise<void>;

  /** Declared dimensions of chunks.embedding, or null if unconstrained/missing. */
  embeddingColumnDimensions(): Promise<number | null>;

  searchVector(vector: readonly number[], embeddingModel: string, limit: number): Promise<SearchHit[]>;
  /** Full-text search with OR semantics over the query's lexemes, ranked by ts_rank_cd. */
  searchFullText(query: string, limit: number): Promise<SearchHit[]>;
  /** Vector and full-text candidate lists for one query, each with cosine similarity. */
  searchCandidates(query: CandidateQuery): Promise<CandidateLists>;

  close(): Promise<void>;
}
