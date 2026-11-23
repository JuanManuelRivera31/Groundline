import { parseArgs } from 'node:util';
import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_RRF_K,
  embedMisses,
  fuseRrf,
  pacificDayStart,
  planEmbeddings,
  RateLimiter,
} from '@groundline/core';
import type { SearchHit } from '@groundline/db';
import { PgDb } from '@groundline/db/node';
import { loadConfig } from '../env.ts';
import { cacheStoreFor, TOKEN_SAFETY_FACTOR, usageRecorderFor } from '../pipeline.ts';
import { createEmbeddingClient, errorMessage, systemClock, systemSleep } from '../runtime.ts';

const USAGE = 'Usage: pnpm search:debug "<question>" [--limit 5]';
const CANDIDATES = 20;

function printHits(title: string, hits: readonly SearchHit[]): void {
  console.log(`\n${title}`);
  if (hits.length === 0) {
    console.log('  (no results)');
    return;
  }
  hits.forEach((hit, i) => {
    console.log(`  ${i + 1}. ${hit.score.toFixed(4)}  ${hit.headingPath}`);
    console.log(`     ${hit.url}`);
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { limit: { type: 'string', default: '5' }, help: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  const question = positionals.join(' ').trim();
  if (values.help || !question) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('--limit must be an integer between 1 and 50.');

  const config = loadConfig();
  const { model, dimensions, limits } = config.embedding;
  const db = new PgDb(config.databaseUrl);
  try {
    console.log(`Question: ${question}`);

    const cache = cacheStoreFor(db);
    const plan = await planEmbeddings(cache, { model, dimensions }, [question], 'RETRIEVAL_QUERY');
    let vector = plan.cached.get(plan.keys[0] ?? '');
    let source = 'cache';
    if (!vector) {
      const client = createEmbeddingClient(config);
      if (client) {
        const usedToday = await db.sumApiRequestsSince(new Date(pacificDayStart(Date.now())), model);
        const { vectors } = await embedMisses(
          {
            client,
            cache,
            limiter: new RateLimiter({ limits, clock: systemClock, sleep: systemSleep, usedToday }),
            usage: usageRecorderFor(db, null),
            retry: { ...DEFAULT_RETRY_POLICY, maxRetries: config.embedding.maxRetries },
            sleep: systemSleep,
            random: Math.random,
            kind: 'embed_query',
            tokenSafetyFactor: TOKEN_SAFETY_FACTOR,
          },
          plan.misses,
          'RETRIEVAL_QUERY',
          Math.floor(limits.tpm / 2),
        );
        vector = vectors.get(plan.keys[0] ?? '');
        source = 'API (1 request)';
      }
    }

    if (vector) {
      console.log(`Query embedding: ${source}`);
      const candidates = await db.searchCandidates({
        query: question,
        vector,
        embeddingModel: model,
        vectorK: CANDIDATES,
        ftsK: CANDIDATES,
      });
      printHits(`Vector top ${limit} (cosine similarity)`, candidates.vector.slice(0, limit));
      printHits(`Full-text top ${limit} (ts_rank_cd, OR semantics)`, candidates.fullText.slice(0, limit));
      const fused = fuseRrf(
        [
          { name: 'vector', items: candidates.vector },
          { name: 'fts', items: candidates.fullText },
        ],
        { k: DEFAULT_RRF_K, limit },
      );
      console.log(`\nHybrid top ${limit} (RRF k=${DEFAULT_RRF_K} over ${CANDIDATES}+${CANDIDATES} candidates)`);
      fused.forEach((hit, i) => {
        const ranks = `vec ${String(hit.ranks.vector ?? '-')} / fts ${String(hit.ranks.fts ?? '-')}`;
        const cosine = hit.cosine === null ? 'n/a' : hit.cosine.toFixed(4);
        console.log(`  ${i + 1}. rrf ${hit.rrfScore.toFixed(4)} | cos ${cosine} | ${ranks}  ${hit.item.headingPath}`);
        console.log(`     ${hit.item.url}`);
      });
    } else {
      console.log('\nVector and hybrid search skipped: GEMINI_API_KEY is not set and the query is not cached.');
      printHits(`Full-text top ${limit} (ts_rank_cd, OR semantics)`, await db.searchFullText(question, limit));
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
