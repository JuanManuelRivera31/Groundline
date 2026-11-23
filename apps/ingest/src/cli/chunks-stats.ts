import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCorpus } from '../corpus.ts';
import { corpusDir } from '../paths.ts';
import { errorMessage } from '../runtime.ts';
import { getSource } from '../sources/index.ts';
import { chunkQualityStats, mulberry32, sampleChunks } from '../stats.ts';

const USAGE = 'Usage: pnpm chunks:stats --source <key> [--samples 3] [--seed 42]';

/** Chunk quality report computed from the local checkout. No network, no database. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      samples: { type: 'string', default: '3' },
      seed: { type: 'string', default: '42' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help || !values.source) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const source = getSource(values.source);
  const dir = corpusDir(source.key);
  if (!existsSync(join(dir, source.docsDir))) {
    throw new Error(`No checkout at ${dir}. Run "pnpm ingest --source ${source.key} --dry-run" first.`);
  }

  const corpus = await loadCorpus(source, dir);
  const stats = chunkQualityStats(corpus);
  console.log(`Chunk quality for ${source.key}`);
  console.log(`  documents ${stats.documents} | chunks ${stats.chunks}`);
  console.log(
    `  tokens min ${stats.tokens.min} | median ${stats.tokens.median} | p95 ${stats.tokens.p95} | max ${stats.tokens.max}`,
  );
  console.log(`  chunks under 60 tokens: ${stats.under60Tokens}`);
  console.log('  top documents by chunk count:');
  for (const doc of stats.topDocuments) console.log(`    ${doc.chunks}  ${doc.path}`);

  const samples = sampleChunks(corpus, Number(values.samples), mulberry32(Number(values.seed)));
  samples.forEach((chunk, i) => {
    console.log(`\n--- Sample ${i + 1} (${chunk.tokens} tokens) ---`);
    console.log(`heading_path: ${chunk.headingPath}`);
    console.log(`url: ${chunk.url}`);
    console.log('content:');
    console.log(chunk.content);
  });
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
