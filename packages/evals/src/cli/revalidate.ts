import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_QUOTE_BOUNDS, groupSources, planEmbeddings } from '@groundline/core';
import { PgDb } from '@groundline/db/node';
import { createAnswerRuntime } from '../answer-runtime.ts';
import { batches, codeMetricsMarkdown, computeCodeMetrics, judgeItemFromRecord, type AnswerRecord } from '../answers.ts';
import { cacheStoreFor, errorMessage, loadConfig, REPO_ROOT } from '../io.ts';
import { revalidateRecord } from '../revalidate.ts';
import { parseJsonl, toJsonl } from '../schema.ts';

const USAGE = 'Usage: pnpm eval:revalidate evals/runs/<date>-answers[-label].json   (no API calls)';

interface RunFile {
  kind: string;
  set: string;
  label: string;
  createdAt: string;
  promptVersion?: string;
  config: { sources: number; candidates: number };
  records: AnswerRecord[];
}

const rel = (p: string): string => p.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === '--help') {
    console.log(USAGE);
    process.exitCode = arg ? 0 : 1;
    return;
  }
  const runPath = resolve(arg);
  const base = runPath.replace(/\.json$/, '');
  const out = `${base}-revalidated`;
  if (existsSync(`${out}.json`)) throw new Error(`${rel(out)}.json already exists.`);
  const run = JSON.parse(await readFile(runPath, 'utf8')) as RunFile;
  if (run.kind !== 'answers' || run.set !== 'dev') throw new Error('Only dev answer runs can be revalidated.');

  const config = loadConfig();
  const db = new PgDb(config.databaseUrl);
  try {
    // Rebuild the exact sources each answer saw: cached query embeddings + DB retrieval, no API.
    const runtime = await createAnswerRuntime(config, db, { embedKind: 'embed_query_eval', mode: 'eval' });
    const plan = await planEmbeddings(cacheStoreFor(db), config.embedding, run.records.map((r) => r.question), 'RETRIEVAL_QUERY');
    if (plan.misses.length > 0) throw new Error(`${plan.misses.length} questions are not cached; revalidation makes no API calls.`);

    const results = [];
    for (const [i, record] of run.records.entries()) {
      const vector = plan.cached.get(plan.keys[i] ?? '');
      if (!vector) throw new Error(`Missing cached embedding for ${record.id}.`);
      const ranked = await runtime.deps.retrieve(record.question, vector, run.config.candidates);
      const sources = groupSources(ranked, run.config.sources);
      const recorded = record.sources.map((s) => s.url).join('|');
      if (sources.map((s) => s.url).join('|') !== recorded) throw new Error(`${record.id}: rebuilt sources differ from the recorded ones.`);
      results.push(revalidateRecord(record, sources, DEFAULT_QUOTE_BOUNDS));
    }

    const records = results.map((r) => r.record);
    const changed = results.filter((r) => r.changedStatus).map((r) => r.record);
    const metrics = computeCodeMetrics(records);
    const createdAt = new Date().toISOString();
    const transitions: Record<string, number> = {};
    for (const [i, r] of results.entries()) {
      if (!r.changedStatus) continue;
      const key = `${run.records[i]?.status ?? '?'} -> ${r.record.status}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
    }
    const revalidation = {
      source: rel(runPath),
      quoteBounds: DEFAULT_QUOTE_BOUNDS,
      note: 'Answers reconstructed from stored records (no API): removed sentences re-joined; courtesy-only sentences and line breaks of downgraded answers were not stored.',
      reconstructed: results.filter((r) => r.reconstructed).length,
      changedStatus: changed.map((r) => r.id),
      transitions,
      restoredSentences: results.reduce((sum, r) => sum + Math.max(0, r.restoredSentences), 0),
    };
    const payload = { ...run, label: `${run.label ? `${run.label}-` : ''}revalidated`, createdAt, revalidation, metrics, records };
    await writeFile(`${out}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeFile(
      `${out}.md`,
      `# Answers run re-validated (dev)\n\n- Source: \`${revalidation.source}\`; quote bounds ${DEFAULT_QUOTE_BOUNDS.minWords}–${DEFAULT_QUOTE_BOUNDS.maxWords} words; no API calls.\n` +
        `- ${revalidation.note}\n- Status changes: ${changed.length} (${JSON.stringify(transitions)}); restored sentences: ${revalidation.restoredSentences}.\n\n${codeMetricsMarkdown(metrics)}`,
      'utf8',
    );

    // Judge only the items whose status changed; inherit the original judgments for the rest.
    const judgeDir = `${out}-judge`;
    const judgmentsDir = `${out}-judgments`;
    await mkdir(judgeDir, { recursive: true });
    await mkdir(judgmentsDir, { recursive: true });
    for (const [i, batch] of batches(changed.map(judgeItemFromRecord), 10).entries()) {
      await writeFile(join(judgeDir, `batch-${String(i + 1).padStart(2, '0')}.jsonl`), toJsonl(batch), 'utf8');
    }
    const changedIds = new Set(changed.map((r) => r.id));
    const originalDir = `${base}-judgments`;
    if (!existsSync(originalDir)) throw new Error(`Missing ${rel(originalDir)} to inherit judgments from.`);
    const inherited = (await Promise.all((await readdir(originalDir)).filter((f) => f.endsWith('.jsonl')).map((f) => readFile(join(originalDir, f), 'utf8'))))
      .flatMap((text) => parseJsonl(text))
      .filter((j) => !changedIds.has((j as { id: string }).id));
    await writeFile(join(judgmentsDir, 'inherited-s3.jsonl'), toJsonl(inherited), 'utf8');

    console.log(`Revalidated ${records.length} records (${revalidation.reconstructed} reconstructed), no API calls.`);
    console.log(`Status changes: ${changed.length} ${JSON.stringify(transitions)}; restored sentences: ${revalidation.restoredSentences}.`);
    console.log(`Run: ${rel(out)}.json | judge batches (changed only): ${rel(judgeDir)}/ | inherited judgments: ${inherited.length}`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
