import { parseArgs } from 'node:util';
import { PgDb } from '@groundline/db/node';
import { loadCorpus } from '../corpus.ts';
import { loadConfig, redactDatabaseUrl } from '../env.ts';
import { ensureCheckout } from '../git.ts';
import { corpusDir } from '../paths.ts';
import { runIngest } from '../pipeline.ts';
import { createEmbeddingClient, defaultsNotice, describeConfig, errorMessage, systemClock, systemSleep } from '../runtime.ts';
import { getSource } from '../sources/index.ts';

const USAGE = 'Usage: pnpm ingest --source <key> [--dry-run]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help || !values.source) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const started = Date.now();
  const config = loadConfig();
  const source = getSource(values.source);
  const dryRun = values['dry-run'];
  console.log(`Ingest ${source.key}${dryRun ? ' (dry run)' : ''}`);
  console.log(`  ${describeConfig(config)}`);
  const notice = defaultsNotice(config);
  if (notice) console.log(`  ${notice}`);
  console.log(`  database ${redactDatabaseUrl(config.databaseUrl)}`);

  const dir = corpusDir(source.key);
  const checkout = await ensureCheckout(source.repoUrl, dir, source.commit);
  console.log(`  corpus ${source.repoUrl} @ ${checkout.commit}${checkout.cloned ? ' (cloned)' : checkout.fetched ? ' (fetched)' : ''}`);

  const corpus = await loadCorpus(source, dir);
  for (const skipped of corpus.skipped) console.log(`  skipped ${skipped.path}: ${skipped.reason}`);

  const db = new PgDb(config.databaseUrl);
  try {
    const migrations = await db.migrate();
    if (migrations.applied.length > 0) console.log(`  applied migrations: ${migrations.applied.join(', ')}`);

    const summary = await runIngest(
      {
        db,
        config,
        client: createEmbeddingClient(config),
        clock: systemClock,
        sleep: systemSleep,
        random: Math.random,
        log: (line) => {
          console.log(line);
        },
      },
      source,
      corpus,
      checkout.commit,
      { dryRun },
    );

    if (summary.dryRun) {
      console.log('Dry run: no API calls made, database content unchanged.');
      return;
    }
    const embed = summary.embed;
    const sync = summary.sync;
    console.log('Summary:');
    console.log(`  run #${String(summary.runId)} | commit ${summary.commit}`);
    console.log(`  documents ${summary.estimate.documents} | chunks ${summary.estimate.chunks} | tokens ~${summary.estimate.tokens}`);
    console.log(
      `  API: ${embed?.httpCalls ?? 0} HTTP calls, ${embed?.quotaRequests ?? 0} quota requests, ${embed?.retries ?? 0} retries` +
        (embed && embed.errorStatuses.length > 0 ? `, error statuses [${embed.errorStatuses.join(', ')}]` : ''),
    );
    console.log(`  cache hits ${summary.estimate.cacheHits} of ${summary.estimate.chunks}`);
    if (sync) {
      console.log(
        `  chunks: ${sync.chunksInserted} inserted, ${sync.chunksUpdated} updated, ${sync.chunksUnchanged} unchanged, ${sync.chunksDeleted} deleted | ` +
          `documents: ${sync.documentsInserted} inserted, ${sync.documentsUpdated} updated, ${sync.documentsDeleted} deleted`,
      );
    }
    if (embed && embed.embeddedTexts > 0) {
      console.log(`  request shape accepted by the API: ${config.embedding.requestShape} (GEMINI_EMBED_REQUEST_SHAPE)`);
    }
    if (embed && Object.keys(embed.observedHeaders).length > 0) {
      console.log(`  rate-limit headers seen: ${JSON.stringify(embed.observedHeaders)}`);
    } else if (embed) {
      console.log('  rate-limit headers seen: none');
    }
    console.log(`  duration ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
