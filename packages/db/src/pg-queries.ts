import type { QueryResult, QueryResultRow } from 'pg';
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
} from './types.ts';
import type {
  ApiStore,
  ConversationQuery,
  ConversationRecord,
  DailyApiUsage,
  DailyConversationStats,
  GapRow,
  HandoffInput,
  HandoffRecord,
  HandoffWithConversation,
  PurgeResult,
  RateLimitDecision,
  RateLimitRequest,
} from './api-types.ts';
import { parseVectorLiteral, toVectorLiteral } from './vector.ts';

const SEARCH_COLUMNS = `c.id AS chunk_id, c.ord, c.heading_path, c.url, c.content, d.title AS document_title`;

interface SearchRow {
  chunk_id: string;
  ord: number;
  /** float8 arrives as number, float4 (ts_rank_cd) may arrive as string depending on type parsers. */
  score: number | string;
  heading_path: string;
  url: string;
  content: string;
  document_title: string;
}

const toHit = (row: SearchRow): SearchHit => ({
  chunkId: Number(row.chunk_id),
  ord: row.ord,
  score: Number(row.score),
  headingPath: row.heading_path,
  url: row.url,
  content: row.content,
  documentTitle: row.document_title,
});

const CONVERSATION_COLUMNS = `id, created_at, question_redacted, lang, status, answer, sources, articles, handoff_offered, answered_by,
  floor_hit, hedged, nearest_url, nearest_title, max_similarity, latency_ms, generation_requests, prompt_tokens, output_tokens,
  thoughts_tokens, cost_usd, country, error`;

interface ConversationRow {
  id: string;
  created_at: Date;
  question_redacted: string | null;
  lang: string;
  status: string;
  answer: string;
  sources: ConversationRecord['sources'];
  articles: ConversationRecord['articles'];
  handoff_offered: boolean;
  answered_by: string | null;
  floor_hit: boolean;
  hedged: boolean;
  nearest_url: string | null;
  nearest_title: string | null;
  max_similarity: number | null;
  latency_ms: number;
  generation_requests: number;
  prompt_tokens: number;
  output_tokens: number;
  thoughts_tokens: number;
  cost_usd: number | null;
  country: string | null;
  error: string | null;
}

const toConversation = (r: ConversationRow): ConversationRecord => ({
  id: r.id,
  createdAt: r.created_at,
  questionRedacted: r.question_redacted,
  lang: r.lang === 'es' ? 'es' : 'en',
  status: r.status,
  answer: r.answer,
  sources: r.sources,
  articles: r.articles,
  handoffOffered: r.handoff_offered,
  answeredBy: r.answered_by,
  floorHit: r.floor_hit,
  hedged: r.hedged,
  nearestUrl: r.nearest_url,
  nearestTitle: r.nearest_title,
  maxSimilarity: r.max_similarity,
  latencyMs: r.latency_ms,
  generationRequests: r.generation_requests,
  promptTokens: r.prompt_tokens,
  outputTokens: r.output_tokens,
  thoughtsTokens: r.thoughts_tokens,
  costUsd: r.cost_usd,
  country: r.country,
  error: r.error,
});

const HANDOFF_COLUMNS = 'id, conversation_id, created_at, note_redacted, delivery_status, delivered_at';

interface HandoffRow {
  id: string;
  conversation_id: string;
  created_at: Date;
  note_redacted: string | null;
  delivery_status: string;
  delivered_at: Date | null;
}

const toHandoff = (r: HandoffRow): HandoffRecord => ({
  id: r.id,
  conversationId: r.conversation_id,
  createdAt: r.created_at,
  noteRedacted: r.note_redacted,
  deliveryStatus: r.delivery_status,
  deliveredAt: r.delivered_at,
});

/** The query surface shared by pg.Pool, pg.PoolClient and pg.Client. */
export interface PgConnection {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * All SQL of the kit, independent of the connection lifecycle. The Node adapter
 * (PgDb) runs it on a pg.Pool; the Workers adapter (ClientDb) on one pg.Client
 * per request. No Node APIs here, so it bundles for Cloudflare Workers.
 */
export abstract class PgQueries implements Db, ApiStore {
  /** Runs one statement. */
  protected abstract run<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  /** Runs `fn` on one dedicated connection (needed for transactions). */
  protected abstract withConnection<T>(fn: (connection: PgConnection) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  async upsertSource(source: SourceInput): Promise<number> {
    const { rows } = await this.run<{ id: string }>(
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

  syncSource(sourceId: number, documents: readonly SyncDocument[]): Promise<SyncStats> {
    return this.withConnection(async (client) => {
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
      }
    });
  }

  async getCachedEmbeddings(keys: readonly string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    if (keys.length === 0) return result;
    const { rows } = await this.run<{ key: string; embedding: string }>(
      'SELECT key, embedding::text AS embedding FROM embedding_cache WHERE key = ANY($1::text[])',
      [keys],
    );
    for (const row of rows) result.set(row.key, parseVectorLiteral(row.embedding));
    return result;
  }

  async putCachedEmbeddings(entries: readonly CachedEmbeddingRow[]): Promise<void> {
    if (entries.length === 0) return;
    await this.run(
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
    await this.run(
      `INSERT INTO api_usage (kind, model, requests, est_tokens, http_status, ingest_run_id,
                              prompt_tokens, output_tokens, thoughts_tokens, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        usage.kind,
        usage.model,
        usage.requests,
        usage.estTokens,
        usage.httpStatus,
        usage.ingestRunId ?? null,
        usage.promptTokens ?? null,
        usage.outputTokens ?? null,
        usage.thoughtsTokens ?? null,
        usage.latencyMs ?? null,
      ],
    );
  }

  async sumApiRequestsSince(since: Date, model: string): Promise<number> {
    const { rows } = await this.run<{ total: string | null }>(
      'SELECT sum(requests) AS total FROM api_usage WHERE ts >= $1 AND model = $2',
      [since, model],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async startIngestRun(run: IngestRunStart): Promise<number> {
    const { rows } = await this.run<{ id: string }>(
      `INSERT INTO ingest_runs (source_id, commit_sha, embedding_model, embedding_dims, status)
       VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
      [run.sourceId, run.commitSha, run.embeddingModel, run.embeddingDims],
    );
    return Number(rows[0]?.id);
  }

  async finishIngestRun(id: number, result: IngestRunFinish): Promise<void> {
    await this.run(
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
    const { rows } = await this.run<{ typmod: number }>(
      `SELECT atttypmod AS typmod FROM pg_attribute
       WHERE attrelid = 'chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`,
    );
    const typmod = rows[0]?.typmod;
    return typmod === undefined || typmod < 0 ? null : typmod;
  }

  async searchVector(vector: readonly number[], embeddingModel: string, limit: number): Promise<SearchHit[]> {
    const { rows } = await this.run<SearchRow>(
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
    const { rows } = await this.run<SearchRow>(
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
    const vectorRows = this.run<SearchRow>(
      `SELECT ${SEARCH_COLUMNS}, 1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL AND c.embedding_model = $2
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [vector, q.embeddingModel, q.vectorK],
    );
    // Same OR semantics as searchFullText, plus the cosine of each hit to the query vector.
    const ftsRows = this.run<SearchRow & { cosine: number | string | null }>(
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

  // ---- Demo API (ADR-0012) ----

  async ping(): Promise<void> {
    await this.run('SELECT 1');
  }

  consumeRateLimit(request: RateLimitRequest): Promise<RateLimitDecision> {
    return this.withConnection(async (client) => {
      await client.query('BEGIN');
      try {
        // Transaction-level lock: serializes concurrent requests of one hash and
        // works behind transaction-mode poolers (PgBouncer, Hyperdrive).
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [request.ipHash]);
        const minuteStart = new Date(request.now.getTime() - 60_000);
        const { rows } = await client.query<{ minute_count: string; day_count: string; oldest: Date | null }>(
          `SELECT count(*) FILTER (WHERE ts > $2) AS minute_count,
                  count(*) FILTER (WHERE ts >= $3) AS day_count,
                  min(ts) FILTER (WHERE ts > $2) AS oldest
           FROM demo_requests WHERE ip_hash = $1 AND ts >= least($2::timestamptz, $3::timestamptz)`,
          [request.ipHash, minuteStart, request.dayStart],
        );
        const minuteCount = Number(rows[0]?.minute_count ?? 0);
        const dayCount = Number(rows[0]?.day_count ?? 0);
        const allowed = minuteCount < request.perMinute && dayCount < request.perDay;
        if (allowed) await client.query('INSERT INTO demo_requests (ip_hash, ts) VALUES ($1, $2)', [request.ipHash, request.now]);
        await client.query('COMMIT');
        return { allowed, minuteCount, dayCount, oldestInMinute: rows[0]?.oldest ?? null };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async insertConversation(c: ConversationRecord): Promise<void> {
    await this.run(
      `INSERT INTO conversations (id, created_at, question_redacted, lang, status, answer, sources, articles, handoff_offered,
         answered_by, floor_hit, hedged, nearest_url, nearest_title, max_similarity, latency_ms, generation_requests,
         prompt_tokens, output_tokens, thoughts_tokens, cost_usd, country, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        c.id,
        c.createdAt,
        c.questionRedacted,
        c.lang,
        c.status,
        c.answer,
        JSON.stringify(c.sources),
        JSON.stringify(c.articles),
        c.handoffOffered,
        c.answeredBy,
        c.floorHit,
        c.hedged,
        c.nearestUrl,
        c.nearestTitle,
        c.maxSimilarity,
        Math.round(c.latencyMs),
        c.generationRequests,
        c.promptTokens,
        c.outputTokens,
        c.thoughtsTokens,
        c.costUsd,
        c.country,
        c.error,
      ],
    );
  }

  async getConversation(id: string): Promise<ConversationRecord | null> {
    const { rows } = await this.run<ConversationRow>(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1`, [id]);
    const row = rows[0];
    return row ? toConversation(row) : null;
  }

  async listConversations(query: ConversationQuery): Promise<ConversationRecord[]> {
    const { rows } = await this.run<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations
       WHERE ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC, id
       LIMIT $3`,
      [query.status ?? null, query.before ?? null, query.limit],
    );
    return rows.map(toConversation);
  }

  async insertHandoff(h: HandoffInput): Promise<{ readonly created: boolean; readonly handoff: HandoffRecord }> {
    const inserted = await this.run<HandoffRow>(
      `INSERT INTO handoffs (id, conversation_id, created_at, note_redacted, delivery_status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conversation_id) DO NOTHING
       RETURNING ${HANDOFF_COLUMNS}`,
      [h.id, h.conversationId, h.createdAt, h.noteRedacted, h.deliveryStatus],
    );
    const row = inserted.rows[0];
    if (row) return { created: true, handoff: toHandoff(row) };
    const existing = await this.run<HandoffRow>(`SELECT ${HANDOFF_COLUMNS} FROM handoffs WHERE conversation_id = $1`, [h.conversationId]);
    const found = existing.rows[0];
    if (!found) throw new Error('insertHandoff: conflicting case not found');
    return { created: false, handoff: toHandoff(found) };
  }

  async updateHandoffDelivery(id: string, deliveryStatus: string, deliveredAt: Date | null): Promise<void> {
    await this.run('UPDATE handoffs SET delivery_status = $2, delivered_at = $3 WHERE id = $1', [id, deliveryStatus, deliveredAt]);
  }

  async listHandoffs(query: { readonly before?: Date | undefined; readonly limit: number }): Promise<HandoffWithConversation[]> {
    const { rows } = await this.run<HandoffRow & { question_redacted: string | null; status: string; answer: string }>(
      `SELECT h.id, h.conversation_id, h.created_at, h.note_redacted, h.delivery_status, h.delivered_at,
              c.question_redacted, c.status, c.answer
       FROM handoffs h JOIN conversations c ON c.id = h.conversation_id
       WHERE ($1::timestamptz IS NULL OR h.created_at < $1)
       ORDER BY h.created_at DESC, h.id
       LIMIT $2`,
      [query.before ?? null, query.limit],
    );
    return rows.map((r) => ({ ...toHandoff(r), questionRedacted: r.question_redacted, status: r.status, answer: r.answer }));
  }

  async gapRows(query: { readonly since: Date; readonly limit: number }): Promise<GapRow[]> {
    const { rows } = await this.run<{
      question_redacted: string;
      nearest_url: string | null;
      nearest_title: string | null;
      max_similarity: number | null;
      created_at: Date;
    }>(
      `SELECT question_redacted, nearest_url, nearest_title, max_similarity, created_at
       FROM conversations
       WHERE status = 'insufficient' AND question_redacted IS NOT NULL AND created_at >= $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [query.since, query.limit],
    );
    return rows.map((r) => ({
      questionRedacted: r.question_redacted,
      nearestUrl: r.nearest_url,
      nearestTitle: r.nearest_title,
      maxSimilarity: r.max_similarity,
      createdAt: r.created_at,
    }));
  }

  async dailyStats(since: Date): Promise<{ readonly conversations: DailyConversationStats[]; readonly apiUsage: DailyApiUsage[] }> {
    const day = (column: string): string => `to_char((${column} AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`;
    const [totals, statuses, usage] = await Promise.all([
      this.run<{
        day: string;
        total: string;
        model_eligible: string;
        unavailable: string;
        p50: number | null;
        p95: number | null;
        prompt_tokens: string;
        output_tokens: string;
        thoughts_tokens: string;
        cost_usd: number | null;
      }>(
        `SELECT ${day('created_at')} AS day,
                count(*) AS total,
                count(*) FILTER (WHERE NOT floor_hit AND status NOT IN ('region_blocked', 'articles_only')) AS model_eligible,
                count(*) FILTER (WHERE status = 'unavailable') AS unavailable,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status <> 'region_blocked') AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status <> 'region_blocked') AS p95,
                coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
                coalesce(sum(output_tokens), 0) AS output_tokens,
                coalesce(sum(thoughts_tokens), 0) AS thoughts_tokens,
                sum(cost_usd) AS cost_usd
         FROM conversations WHERE created_at >= $1
         GROUP BY 1 ORDER BY 1`,
        [since],
      ),
      this.run<{ day: string; status: string; n: string }>(
        `SELECT ${day('created_at')} AS day, status, count(*) AS n
         FROM conversations WHERE created_at >= $1
         GROUP BY 1, 2`,
        [since],
      ),
      this.run<{ day: string; model: string; calls: string; requests: string; failed: string; prompt_tokens: string; output_tokens: string }>(
        `SELECT ${day('ts')} AS day, model, count(*) AS calls, coalesce(sum(requests), 0) AS requests,
                count(*) FILTER (WHERE http_status IS DISTINCT FROM 200) AS failed,
                coalesce(sum(prompt_tokens), 0) AS prompt_tokens, coalesce(sum(output_tokens), 0) AS output_tokens
         FROM api_usage WHERE ts >= $1
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [since],
      ),
    ]);
    const byDay = new Map<string, Record<string, number>>();
    for (const r of statuses.rows) {
      const entry = byDay.get(r.day) ?? {};
      entry[r.status] = Number(r.n);
      byDay.set(r.day, entry);
    }
    return {
      conversations: totals.rows.map((r) => ({
        day: r.day,
        total: Number(r.total),
        byStatus: byDay.get(r.day) ?? {},
        modelEligible: Number(r.model_eligible),
        unavailable: Number(r.unavailable),
        latencyP50Ms: r.p50,
        latencyP95Ms: r.p95,
        promptTokens: Number(r.prompt_tokens),
        outputTokens: Number(r.output_tokens),
        thoughtsTokens: Number(r.thoughts_tokens),
        costUsd: r.cost_usd ?? 0,
      })),
      apiUsage: usage.rows.map((r) => ({
        day: r.day,
        model: r.model,
        calls: Number(r.calls),
        requests: Number(r.requests),
        failed: Number(r.failed),
        promptTokens: Number(r.prompt_tokens),
        outputTokens: Number(r.output_tokens),
      })),
    };
  }

  purgeExpired(cutoffs: { readonly conversationsBefore: Date; readonly rateLimitBefore: Date }): Promise<PurgeResult> {
    return this.withConnection(async (client) => {
      await client.query('BEGIN');
      try {
        const handoffs = await client.query(
          'DELETE FROM handoffs WHERE conversation_id IN (SELECT id FROM conversations WHERE created_at < $1)',
          [cutoffs.conversationsBefore],
        );
        const conversations = await client.query('DELETE FROM conversations WHERE created_at < $1', [cutoffs.conversationsBefore]);
        const events = await client.query('DELETE FROM demo_requests WHERE ts < $1', [cutoffs.rateLimitBefore]);
        await client.query('COMMIT');
        return { conversations: conversations.rowCount ?? 0, handoffs: handoffs.rowCount ?? 0, rateLimitEvents: events.rowCount ?? 0 };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
}
