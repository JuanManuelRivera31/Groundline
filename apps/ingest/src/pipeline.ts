import {
  batchMisses,
  DEFAULT_RETRY_POLICY,
  embedMisses,
  estimateTokens,
  pacificDayStart,
  planEmbeddings,
  QuotaExceededError,
  RateLimiter,
  type AppConfig,
  type Clock,
  type EmbeddingCacheStore,
  type EmbeddingClient,
  type EmbedStats,
  type Sleep,
  type UsageRecorder,
} from '@groundline/core';
import type { Db, SyncDocument, SyncStats } from '@groundline/db';
import type { Corpus } from './corpus.ts';
import type { SourceDefinition } from './sources/index.ts';

export const TOKEN_SAFETY_FACTOR = 1.2;

export interface IngestDeps {
  readonly db: Db;
  readonly config: AppConfig;
  /** Undefined when no API key is configured (dry runs and fully cached runs still work). */
  readonly client: EmbeddingClient | undefined;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly random: () => number;
  readonly log: (line: string) => void;
}

export interface IngestEstimate {
  readonly documents: number;
  readonly chunks: number;
  readonly tokens: number;
  readonly cacheHits: number;
  readonly textsToEmbed: number;
  readonly tokensToEmbed: number;
  /** Quota units (worst case: one per text). */
  readonly quotaRequests: number;
  readonly httpCalls: number;
  readonly estimatedMinutes: number;
  readonly usedToday: number;
  readonly remainingToday: number;
}

export interface IngestSummary {
  readonly dryRun: boolean;
  readonly runId: number | null;
  readonly commit: string;
  readonly estimate: IngestEstimate;
  readonly embed: EmbedStats | null;
  readonly sync: SyncStats | null;
  readonly durationMs: number;
}

export function cacheStoreFor(db: Db): EmbeddingCacheStore {
  return {
    getMany: (keys) => db.getCachedEmbeddings(keys),
    putMany: (entries) => db.putCachedEmbeddings(entries),
  };
}

export function usageRecorderFor(db: Db, ingestRunId: number | null): UsageRecorder {
  return { record: (event) => db.recordApiUsage({ ...event, ingestRunId }) };
}

/**
 * Embeds (cache-first) and upserts a parsed corpus. Prints the estimate before
 * any API call; a dry run stops right after it.
 */
export async function runIngest(
  deps: IngestDeps,
  source: SourceDefinition,
  corpus: Corpus,
  commit: string,
  options: { readonly dryRun: boolean },
): Promise<IngestSummary> {
  const started = deps.clock.now();
  const { db, config, log } = deps;
  const { model, dimensions, limits } = config.embedding;

  const columnDims = await db.embeddingColumnDimensions();
  if (columnDims !== dimensions) {
    throw new Error(
      `EMBEDDING_DIMS=${dimensions} but chunks.embedding is vector(${String(columnDims)}). ` +
        'Changing dimensions requires a new migration.',
    );
  }

  const chunks = corpus.documents.flatMap((doc) => doc.chunks);
  const texts = chunks.map((chunk) => chunk.embedText);
  const cache = cacheStoreFor(db);
  const plan = await planEmbeddings(cache, { model, dimensions }, texts, 'RETRIEVAL_DOCUMENT');

  const usedToday = await db.sumApiRequestsSince(new Date(pacificDayStart(deps.clock.now())), model);
  const tokensToEmbed = plan.misses.reduce((sum, miss) => sum + estimateTokens(miss.text), 0);
  const maxBatchTokens = Math.floor(limits.tpm / 2);
  const httpCalls = batchMisses(plan.misses, config.embedding.batchSize, Math.floor(maxBatchTokens / TOKEN_SAFETY_FACTOR)).length;
  const estimate: IngestEstimate = {
    documents: corpus.documents.length,
    chunks: chunks.length,
    tokens: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
    cacheHits: plan.cacheHits,
    textsToEmbed: plan.misses.length,
    tokensToEmbed,
    quotaRequests: plan.misses.length,
    httpCalls,
    estimatedMinutes:
      plan.misses.length === 0 ? 0 : Math.max(plan.misses.length / limits.rpm, (tokensToEmbed * TOKEN_SAFETY_FACTOR) / limits.tpm),
    usedToday,
    remainingToday: Math.max(0, limits.rpd - usedToday),
  };

  log('Estimate (before any API call):');
  log(`  documents ${estimate.documents} | chunks ${estimate.chunks} | tokens ~${estimate.tokens}`);
  log(`  cache hits ${estimate.cacheHits} | texts to embed ${estimate.textsToEmbed} (~${estimate.tokensToEmbed} tokens)`);
  log(
    `  quota requests ${estimate.quotaRequests} (worst case: 1 per text) in ${estimate.httpCalls} HTTP calls | ` +
      `~${estimate.estimatedMinutes.toFixed(1)} min at ${limits.rpm} RPM / ${limits.tpm} TPM`,
  );
  log(`  daily quota (${model}): ${estimate.usedToday} used, ${estimate.remainingToday} of ${limits.rpd} remaining`);

  if (options.dryRun) {
    return { dryRun: true, runId: null, commit, estimate, embed: null, sync: null, durationMs: deps.clock.now() - started };
  }
  if (estimate.quotaRequests > estimate.remainingToday) {
    throw new QuotaExceededError(
      `Need ${estimate.quotaRequests} requests but only ${estimate.remainingToday} remain today. ` +
        'Re-run after midnight Pacific time; cached batches are kept.',
    );
  }
  if (plan.misses.length > 0 && !deps.client) {
    throw new Error(`GEMINI_API_KEY is not set and ${plan.misses.length} texts are not cached.`);
  }

  const sourceId = await db.upsertSource({
    key: source.key,
    name: source.name,
    repoUrl: source.repoUrl,
    baseUrl: `${source.site.siteUrl}${source.site.baseUrl}`,
    license: source.license,
    pinnedCommit: source.commit,
  });
  const runId = await db.startIngestRun({ sourceId, commitSha: commit, embeddingModel: model, embeddingDims: dimensions });

  try {
    let embed: EmbedStats | null = null;
    const fresh = new Map<string, readonly number[]>();
    if (plan.misses.length > 0 && deps.client) {
      const limiter = new RateLimiter({ limits, clock: deps.clock, sleep: deps.sleep, usedToday });
      const result = await embedMisses(
        {
          client: deps.client,
          cache,
          limiter,
          usage: usageRecorderFor(db, runId),
          retry: { ...DEFAULT_RETRY_POLICY, maxRetries: config.embedding.maxRetries },
          sleep: deps.sleep,
          random: deps.random,
          kind: 'embed_document',
          tokenSafetyFactor: TOKEN_SAFETY_FACTOR,
          onBatch: ({ done, total }) => {
            log(`  embedded ${done}/${total}`);
          },
        },
        plan.misses,
        'RETRIEVAL_DOCUMENT',
        maxBatchTokens,
      );
      embed = result.stats;
      for (const [key, vector] of result.vectors) fresh.set(key, vector);
    }

    let index = 0;
    const syncDocuments: SyncDocument[] = corpus.documents.map((doc) => ({
      document: { path: doc.path, url: doc.url, title: doc.title, contentHash: doc.contentHash, commitSha: commit },
      chunks: doc.chunks.map((chunk) => {
        const key = plan.keys[index++] ?? '';
        const embedding = plan.cached.get(key) ?? fresh.get(key);
        if (!embedding) throw new Error(`No embedding for chunk ${chunk.ord} of ${doc.path}.`);
        return {
          ord: chunk.ord,
          headingPath: chunk.headingPath,
          anchor: chunk.anchor,
          url: chunk.url,
          content: chunk.content,
          tokens: chunk.tokens,
          contentHash: chunk.contentHash,
          embedding,
          embeddingModel: model,
        };
      }),
    }));
    const sync = await db.syncSource(sourceId, syncDocuments);

    const durationMs = deps.clock.now() - started;
    await db.finishIngestRun(runId, {
      status: 'succeeded',
      documents: estimate.documents,
      chunks: estimate.chunks,
      tokens: estimate.tokens,
      apiCalls: embed?.httpCalls ?? 0,
      apiRequests: embed?.quotaRequests ?? 0,
      cacheHits: plan.cacheHits,
      durationMs,
    });
    return { dryRun: false, runId, commit, estimate, embed, sync, durationMs };
  } catch (error) {
    await db.finishIngestRun(runId, {
      status: 'failed',
      documents: estimate.documents,
      chunks: estimate.chunks,
      tokens: estimate.tokens,
      apiCalls: 0,
      apiRequests: 0,
      cacheHits: plan.cacheHits,
      durationMs: deps.clock.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
