import { parseArgs } from 'node:util';
import { answerQuestion, generationLimitDefaults, planEmbeddings } from '@groundline/core';
import { PgDb } from '@groundline/db/node';
import { createAnswerRuntime } from '@groundline/evals';
import { loadConfig } from '../env.ts';
import { cacheStoreFor } from '../pipeline.ts';
import { errorMessage } from '../runtime.ts';

const USAGE = 'Usage: pnpm ask "<question>"';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ options: { help: { type: 'boolean' } }, allowPositionals: true, strict: true });
  const question = positionals.join(' ').trim();
  if (values.help || question.length === 0) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const config = loadConfig();
  const missingLimits = generationLimitDefaults(config);
  if (missingLimits.length > 0) {
    const l = config.generation.limits;
    console.warn(`Warning: ${missingLimits.join(', ')} not set in .env; using defaults ${l.rpm} RPM / ${l.tpm} TPM / ${l.rpd} RPD.`);
  }
  const db = new PgDb(config.databaseUrl);
  try {
    const runtime = await createAnswerRuntime(config, db, { embedKind: 'embed_query', mode: 'live' });
    const plan = await planEmbeddings(cacheStoreFor(db), config.embedding, [question], 'RETRIEVAL_QUERY');
    const e = runtime.embeddingQuota;
    console.log(
      `Live mode: model chain ${runtime.generationQuotas.map((q) => q.model).join(' → ')}, budget ${config.generation.liveBudgetMs} ms. ` +
        'Generation requests: up to 1 per model (0 if below the floor).',
    );
    for (const q of runtime.generationQuotas) console.log(`  remaining today (${q.model}): ${q.remaining} of ${q.limit}`);
    console.log(`Embedding requests: ${plan.misses.length} | remaining today (${e.model}): ${e.remaining} of ${e.limit}`);
    if (runtime.generationQuotas.every((q) => q.remaining < 1)) throw new Error('No generation quota left today on any chain model (resets at midnight Pacific time).');

    const r = await answerQuestion(runtime.deps, question);
    const cited = new Set(r.citations.map((c) => c.sourceId));
    console.log(`\nStatus: ${r.status}${r.declinedInjection ? ' (injection declined)' : ''}${r.handoffOffered ? ' — hand-off offered' : ''}`);
    if (r.handoffReason) console.log(`Hand-off reason: ${r.handoffReason}`);
    console.log(`\n${r.answer}\n`);
    for (const c of r.citations) console.log(`  [${c.marker}] ${c.url}\n      "${c.quote}"`);
    console.log('\nSources sent to the model:');
    for (const s of r.sources) console.log(`  ${s.id}${cited.has(s.id) ? '*' : ' '} ${(s.similarity ?? 0).toFixed(4)}  ${s.url}`);
    if (r.invalidCitations.length > 0) console.log(`Invalid citations removed: ${r.invalidCitations.map((c) => `[${c.marker}] ${c.reason}`).join(', ')}`);
    if (r.removedSentences.length > 0) console.log(`Sentences removed: ${r.removedSentences.length} (${r.removedSentences.map((s) => s.reason).join(', ')})`);
    if (r.articles.length > 0) console.log(`Articles (${r.retrievalFallback}): ${r.articles.map((a) => a.url).join(', ')}`);
    if (r.error) console.log(`Note: ${r.error}`);
    console.log(
      `Answered by: ${r.answeredBy ?? 'none'} | hops ${r.hops} | retrieval ${r.retrievalFallback} | attempts: ` +
        (r.attempts.map((a) => `${a.model}:${a.status ?? a.outcome} ${a.ms} ms`).join(', ') || 'none'),
    );
    console.log(
      `\nMax similarity ${r.maxSimilarity.toFixed(4)} vs floor ${runtime.deps.config.floor.toFixed(3)}${r.floorHit ? ' (floor hit: model not called)' : ''}` +
        ` | prompt ${r.promptVersion}`,
    );
    console.log(
      `Latency ${(r.latency.totalMs / 1000).toFixed(2)} s (retrieval ${r.latency.retrievalMs} ms, generation ${r.latency.generationMs} ms, queue ${r.latency.queueWaitMs} ms)` +
        ` | tokens prompt ${r.usage.promptTokens}, output ${r.usage.outputTokens}, thoughts ${r.usage.thoughtsTokens}` +
        ` | equivalent cost ${r.costUsd === null ? 'n/a' : `$${r.costUsd.toFixed(6)}`} (free tier: $0)`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
