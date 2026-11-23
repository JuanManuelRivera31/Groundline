import pg from 'pg';
import type {
  ApiUsageInput,
  CachedEmbeddingRow,
  CandidateLists,
  CandidateQuery,
  Db,
  IngestRunFinish,
  IngestRunStart,
  SearchHit,
  SourceInput,
  SyncDocument,
  SyncStats,
} from '../types.ts';
import { parseVectorLiteral, toVectorLiteral } from '../vector.ts';
import { loadMigrations, runMigrations, type MigrationResult } from './migrate.ts';

const SEARCH_COLUMNS = `c.id AS chunk_id, c.heading_path, c.url, c.content, d.title AS document_title`;

interface SearchRow {
  chunk_id: string;
  /** float8 arrives as number, float4 (ts_rank_cd) may arrive as string depending on type parsers. */
  score: number | string;
  heading_path: string;
  url: string;
  content: string;
  document_title: string;
}

const toHit = (row: SearchRow): SearchHit => ({
  chunkId: Number(row.chunk_id),
  score: Number(row.score),
  headingPath: row.heading_path,
  url: row.url,
  content: row.content,
  documentTitle: row.document_title,
});

/** Node adapter: one pg.Pool over TCP (local Docker Postgres). */
export class PgDb implements Db {
  readonly #pool: pg.Pool;

  constructor(connectionString: string) {
    this.#pool = new pg.Pool({ connectionString, max: 4 });
  }

  async migrate(): Promise<MigrationResult> {
    const client = await this.#pool.connect();
    try {
      return await runMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
  }

  async upsertSource(source: SourceInput): Promise<number> {
    const { rows } = await this.#pool.query<{ id: string }>(
      `INSERT INTO sources (key, name, repo_url, base_url, license, pinned_commit)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO UPDATE SET
         name = EXCLUDED.name, repo_url = EXCLUDED.repo_url, base_url = EXCLUDED.base_url,
         license = EXCLUDED.license, pinned_commit = EXCLUDED.pinned_commit, updated_at = now()
       RETURNING id`,
      [source.key, source.name, source.repoUrl, source.baseUrl, source.license, source.pinnedCommit],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('upsertSource returned no id');
    return Number(id);
  }

  async syncSource(sourceId: number, documents: readonly SyncDocument[]): Promise<SyncStats> {
    const client = await this.#pool.connect();
    const stats = {
      documentsInserted: 0,
      documentsUpdated: 0,
      documentsDeleted: 0,
      chunksInserted: 0,
      chunksUpdated: 0,
      chunksUnchanged: 0,
      chunksDeleted: 0,
    };
    try {
      await client.query('BEGIN');
      for (const { document, chunks } of documents) {
        const upserted = await client.query<{ id: string; inserted: boolean }>(
          `INSERT INTO documents (source_id, path, url, title, content_hash, commit_sha)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (source_id, path) DO UPDATE SET
             url = EXCLUDED.url, title = EXCLUDED.title, content_hash = EXCLUDED.content_hash,
             commit_sha = EXCLUDED.commit_sha, updated_at = now()
           WHERE (documents.url, documents.title, documents.content_hash, documents.commit_sha)
                 IS DISTINCT FROM (EXCLUDED.url, EXCLUDED.title, EXCLUDED.content_hash, EXCLUDED.commit_sha)
           RETURNING id, (xmax = 0) AS inserted`,
          [sourceId, document.path, document.url, document.title, document.contentHash, document.commitSha],
        );
        let documentId: number;
        const row = upserted.rows[0];
        if (row) {
          documentId = Number(row.id);
          if (row.inserted) stats.documentsInserted++;
          else stats.documentsUpdated++;
        } else {
          const existing = await client.query<{ id: string }>(
            'SELECT id FROM documents WHERE source_id = $1 AND path = $2',
            [sourceId, document.path],
          );
          documentId = Number(existing.rows[0]?.id);
        }

        if (chunks.length > 0) {
          const result = await client.query<{ inserted: boolean }>(
            `INSERT INTO chunks (document_id, ord, heading_path, anchor, url, content, tokens, content_hash, embedding, embedding_model)
             SELECT $1, u.ord, u.heading_path, u.anchor, u.url, u.content, u.tokens, u.content_hash, u.embedding::vector, u.embedding_model
             FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[], $9::text[], $10::text[])
               AS u(ord, heading_path, anchor, url, content, tokens, content_hash, embedding, embedding_model)
             ON CONFLICT (document_id, ord) DO UPDATE SET
               heading_path = EXCLUDED.heading_path, anchor = EXCLUDED.anchor, url = EXCLUDED.url,
               content = EXCLUDED.content, tokens = EXCLUDED.tokens, content_hash = EXCLUDED.content_hash,
               embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model, updated_at = now()
             WHERE (chunks.content_hash, chunks.heading_path, chunks.anchor, chunks.url, chunks.embedding_model)
                   IS DISTINCT FROM
                   (EXCLUDED.content_hash, EXCLUDED.heading_path, EXCLUDED.anchor, EXCLUDED.url, EXCLUDED.embedding_model)
             RETURNING (xmax = 0) AS inserted`,
            [
              documentId,
              chunks.map((c) => c.ord),
              chunks.map((c) => c.headingPath),
              chunks.map((c) => c.anchor),
              chunks.map((c) => c.url),
              chunks.map((c) => c.content),
              chunks.map((c) => c.tokens),
              chunks.map((c) => c.contentHash),
              chunks.map((c) => toVectorLiteral(c.embedding)),
              chunks.map((c) => c.embeddingModel),
            ],
          );
          const inserted = result.rows.filter((r) => r.inserted).length;
          stats.chunksInserted += inserted;
          stats.chunksUpdated += result.rows.length - inserted;
          stats.chunksUnchanged += chunks.length - result.rows.length;
        }

        const removed = await client.query('DELETE FROM chunks WHERE document_id = $1 AND ord >= $2', [
          documentId,
          chunks.length,
        ]);
        stats.chunksDeleted += removed.rowCount ?? 0;
      }

      const staleChunks = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.source_id = $1 AND NOT (d.path = ANY($2::text[]))`,
        [sourceId, documents.map((d) => d.document.path)],
      );
      stats.chunksDeleted += Number(staleChunks.rows[0]?.n ?? 0);
      const staleDocs = await client.query('DELETE FROM documents WHERE source_id = $1 AND NOT (path = ANY($2::text[]))', [
        sourceId,
        documents.map((d) => d.document.path),
      ]);
      stats.documentsDeleted = staleDocs.rowCount ?? 0;

      await client.query('COMMIT');
      return stats;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getCachedEmbeddings(keys: readonly string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    if (keys.length === 0) return result;
    const { rows } = await this.#pool.query<{ key: string; embedding: string }>(
      'SELECT key, embedding::text AS embedding FROM embedding_cache WHERE key = ANY($1::text[])',
      [keys],
    );
    for (const row of rows) result.set(row.key, parseVectorLiteral(row.embedding));
    return result;
  }

  async putCachedEmbeddings(entries: readonly CachedEmbeddingRow[]): Promise<void> {
    if (entries.length === 0) return;
    await this.#pool.query(
      `INSERT INTO embedding_cache (key, model, dimensions, task_type, embedding)
       SELECT u.key, u.model, u.dimensions, u.task_type, u.embedding::vector
       FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[]) AS u(key, model, dimensions, task_type, embedding)
       ON CONFLICT (key) DO NOTHING`,
      [
        entries.map((e) => e.key),
        entries.map((e) => e.model),
        entries.map((e) => e.dimensions),
        entries.map((e) => e.taskType),
        entries.map((e) => toVectorLiteral(e.vector)),
      ],
    );
  }

  async recordApiUsage(usage: ApiUsageInput): Promise<void> {
    await this.#pool.query(
      `INSERT INTO api_usage (kind, model, requests, est_tokens, http_status, ingest_run_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [usage.kind, usage.model, usage.requests, usage.estTokens, usage.httpStatus, usage.ingestRunId ?? null],
    );
  }

  async sumApiRequestsSince(since: Date, model: string): Promise<number> {
    const { rows } = await this.#pool.query<{ total: string | null }>(
      'SELECT sum(requests) AS total FROM api_usage WHERE ts >= $1 AND model = $2',
      [since, model],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async startIngestRun(run: IngestRunStart): Promise<number> {
    const { rows } = await this.#pool.query<{ id: string }>(
      `INSERT INTO ingest_runs (source_id, commit_sha, embedding_model, embedding_dims, status)
       VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
      [run.sourceId, run.commitSha, run.embeddingModel, run.embeddingDims],
    );
    return Number(rows[0]?.id);
  }

  async finishIngestRun(id: number, result: IngestRunFinish): Promise<void> {
    await this.#pool.query(
      `UPDATE ingest_runs SET status = $2, finished_at = now(), documents = $3, chunks = $4, tokens = $5,
         api_calls = $6, api_requests = $7, cache_hits = $8, duration_ms = $9, error = $10
       WHERE id = $1`,
      [
        id,
        result.status,
        result.documents,
        result.chunks,
        result.tokens,
        result.apiCalls,
        result.apiRequests,
        result.cacheHits,
        result.durationMs,
        result.error ?? null,
      ],
    );
  }

  async embeddingColumnDimensions(): Promise<number | null> {
    const { rows } = await this.#pool.query<{ typmod: number }>(
      `SELECT atttypmod AS typmod FROM pg_attribute
       WHERE attrelid = 'chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`,
    );
    const typmod = rows[0]?.typmod;
    return typmod === undefined || typmod < 0 ? null : typmod;
  }

  async searchVector(vector: readonly number[], embeddingModel: string, limit: number): Promise<SearchHit[]> {
    const { rows } = await this.#pool.query<SearchRow>(
      `SELECT ${SEARCH_COLUMNS}, 1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL AND c.embedding_model = $2
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [toVectorLiteral(vector), embeddingModel, limit],
    );
    return rows.map(toHit);
  }

  async searchFullText(query: string, limit: number): Promise<SearchHit[]> {
    // plainto_tsquery ANDs every lexeme, which almost never matches a natural
    // language question. Re-join its (already stemmed) lexemes with OR and
    // parse with the 'simple' config so they are not stemmed twice.
    const { rows } = await this.#pool.query<SearchRow>(
      `WITH q AS (
         SELECT to_tsquery('simple', replace(plainto_tsquery('english', $1)::text, ' & ', ' | ')) AS query
       )
       SELECT ${SEARCH_COLUMNS}, ts_rank_cd(c.tsv, q.query) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id, q
       WHERE c.tsv @@ q.query
       ORDER BY score DESC, c.id
       LIMIT $2`,
      [query, limit],
    );
    return rows.map(toHit);
  }

  async searchCandidates(q: CandidateQuery): Promise<CandidateLists> {
    const vector = toVectorLiteral(q.vector);
    const vectorRows = this.#pool.query<SearchRow>(
      `SELECT ${SEARCH_COLUMNS}, 1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL AND c.embedding_model = $2
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [vector, q.embeddingModel, q.vectorK],
    );
    // Same OR semantics as searchFullText, plus the cosine of each hit to the query vector.
    const ftsRows = this.#pool.query<SearchRow & { cosine: number | string | null }>(
      `WITH q AS (
         SELECT to_tsquery('simple', replace(plainto_tsquery('english', $1)::text, ' & ', ' | ')) AS query
       )
       SELECT ${SEARCH_COLUMNS}, ts_rank_cd(c.tsv, q.query) AS score,
              CASE WHEN c.embedding IS NOT NULL AND c.embedding_model = $3
                   THEN 1 - (c.embedding <=> $2::vector) END AS cosine
       FROM chunks c JOIN documents d ON d.id = c.document_id, q
       WHERE c.tsv @@ q.query
       ORDER BY score DESC, c.id
       LIMIT $4`,
      [q.query, vector, q.embeddingModel, q.ftsK],
    );
    const [v, f] = await Promise.all([vectorRows, ftsRows]);
    return {
      vector: v.rows.map((row) => {
        const hit = toHit(row);
        return { ...hit, cosine: hit.score };
      }),
      fullText: f.rows.map((row) => ({ ...toHit(row), cosine: row.cosine === null ? null : Number(row.cosine) })),
    };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
