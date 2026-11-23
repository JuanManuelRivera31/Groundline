import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCorpus } from '../corpus.ts';
import { exportChunks, toJsonl } from '../export.ts';
import { corpusDir, DATA_DIR } from '../paths.ts';
import { errorMessage } from '../runtime.ts';
import { getSource } from '../sources/index.ts';

const USAGE = 'Usage: pnpm corpus:export --source <key> [--out data/eval-work/chunks.jsonl]';

/** Exports the chunked corpus to JSONL from the local checkout. No network, no database. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { source: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } },
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

  const rows = await exportChunks(await loadCorpus(source, dir));
  const out = values.out ?? join(DATA_DIR, 'eval-work', 'chunks.jsonl');
  await mkdir(join(out, '..'), { recursive: true });
  await writeFile(out, toJsonl(rows), 'utf8');
  console.log(`Exported ${rows.length} chunks from ${new Set(rows.map((r) => r.doc_path)).size} documents to ${out}`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
