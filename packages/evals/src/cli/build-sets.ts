import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mulberry32, shuffled } from '@groundline/core';
import { buildSets, DEFAULT_BUILD_OPTIONS, maxCrossSimilarity, maxDocShare, type Candidate } from '../build.ts';
import { CHUNKS_FILE, DEV_FILE, errorMessage, EVAL_WORK_DIR, loadChunkRefs, SETS_DIR } from '../io.ts';
import { ALL_CATEGORIES, BEHAVIORS, chunkIndex, FIELD_ORDER, parseJsonl, toJsonl, validateQuestion, type EvalQuestion, type QuestionDraft } from '../schema.ts';

const TEST_FILE = join(SETS_DIR, 'test.jsonl');
const VERIFIED_DIR = join(EVAL_WORK_DIR, 'verified');
const AUDIT_SEED = 20261123;
const AUDIT_SIZE = 20;
const CORPUS = { repo: 'https://github.com/plausible/docs', commit: 'e9a092a987cffc3b29fd546d7cda17534860b83b' };

interface VerifiedLine {
  readonly candidate_id: string;
  readonly verdict: 'keep' | 'fix' | 'discard';
  readonly reason: string;
  readonly record?: QuestionDraft;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function ordered(q: EvalQuestion): Record<string, unknown> {
  return Object.fromEntries(FIELD_ORDER.map((key) => [key, q[key]]));
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

/**
 * Builds and freezes evals/plausible/{dev,test}.jsonl from verified candidates.
 * Write-once: refuses to run if either set already exists. Prints only counts
 * and hashes for the test set, never its content.
 */
async function main(): Promise<void> {
  if (existsSync(TEST_FILE) || existsSync(DEV_FILE)) {
    throw new Error('dev.jsonl or test.jsonl already exists: the sets are frozen and are never rebuilt.');
  }

  const chunks = await loadChunkRefs();
  const index = chunkIndex(chunks);
  const files = (await readdir(VERIFIED_DIR)).filter((f) => f.endsWith('.jsonl')).sort();
  if (files.length === 0) throw new Error(`No verified candidates in ${VERIFIED_DIR}.`);

  const verdicts: VerifiedLine[] = [];
  for (const file of files) {
    verdicts.push(...(parseJsonl(await readFile(join(VERIFIED_DIR, file), 'utf8')) as VerifiedLine[]));
  }
  const ids = new Set<string>();
  for (const v of verdicts) {
    if (ids.has(v.candidate_id)) throw new Error(`Duplicate verdict for ${v.candidate_id}`);
    ids.add(v.candidate_id);
  }

  const candidates: Candidate[] = [];
  const invalid: string[] = [];
  for (const v of verdicts) {
    if (v.verdict === 'discard') continue;
    if (!v.record) throw new Error(`Verdict ${v.verdict} for ${v.candidate_id} has no record.`);
    const errors = validateQuestion(v.record, index);
    if (errors.length > 0) {
      invalid.push(`${v.candidate_id}: ${errors.join('; ')}`);
      continue;
    }
    candidates.push({ ...v.record, candidateId: v.candidate_id });
  }
  if (invalid.length > 0) {
    console.error(`Invalid records after verification (${invalid.length}):\n  ${invalid.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }

  const result = buildSets(candidates, index, DEFAULT_BUILD_OPTIONS);
  if (result.shortfalls.length > 0) {
    console.error('Not enough verified candidates to meet the targets:');
    for (const s of result.shortfalls) console.error(`  ${s.set} ${s.category}: missing ${s.missing}`);
    process.exitCode = 1;
    return;
  }

  const devText = toJsonl(result.dev.map(ordered));
  const testText = toJsonl(result.test.map(ordered));
  await writeFile(DEV_FILE, devText, { encoding: 'utf8', flag: 'wx' });
  await writeFile(TEST_FILE, testText, { encoding: 'utf8', flag: 'wx' });

  const audit = shuffled(result.test, mulberry32(AUDIT_SEED)).slice(0, AUDIT_SIZE);
  const csv = [
    'question,reference_answer,expected_urls',
    ...audit.map((q) => [q.question, q.reference_answer, q.expected_urls.join(' | ')].map(csvCell).join(',')),
  ].join('\n');
  await writeFile(join(SETS_DIR, 'audit_sample.csv'), `${csv}\n`, { encoding: 'utf8', flag: 'wx' });

  const verification = {
    candidates: verdicts.length,
    kept: verdicts.filter((v) => v.verdict === 'keep').length,
    corrected: verdicts.filter((v) => v.verdict === 'fix').length,
    discarded: verdicts.filter((v) => v.verdict === 'discard').length,
    duplicates_dropped_by_builder: result.duplicatesDropped.length,
    unused_after_split: result.unused.length,
  };
  const summarize = (qs: readonly EvalQuestion[]): Record<string, unknown> => ({
    total: qs.length,
    by_behavior: Object.fromEntries(BEHAVIORS.map((b) => [b, qs.filter((q) => q.expected_behavior === b).length])),
    by_category: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, qs.filter((q) => q.category === c).length])),
    max_doc_share: maxDocShare(qs, index),
  });

  const manifest = {
    description: 'Frozen retrieval/answer eval sets for the Plausible demo corpus. Never tune on test.jsonl.',
    created_at: new Date().toISOString(),
    corpus: { ...CORPUS, chunks_file_sha256: sha256(await readFile(CHUNKS_FILE, 'utf8')), chunks: chunks.length },
    chunker: 'ADR-0004 (heading-aware, subtree folding, 500-token cap)',
    generation: {
      generator: 'Claude Sonnet subagents, one per topic plus one for unanswerable questions',
      verifier: 'Separate Claude Opus subagents, checking every label against its source chunk text',
    },
    split: {
      seed: DEFAULT_BUILD_OPTIONS.seed,
      targets: DEFAULT_BUILD_OPTIONS.targets,
      doc_cap: DEFAULT_BUILD_OPTIONS.docCap,
      duplicate_threshold: DEFAULT_BUILD_OPTIONS.duplicateThreshold,
      near_threshold: DEFAULT_BUILD_OPTIONS.nearThreshold,
      max_dev_test_jaccard: Number(maxCrossSimilarity(result.dev, result.test).toFixed(3)),
    },
    verification,
    sets: {
      dev: { file: 'dev.jsonl', sha256: sha256(devText), ...summarize(result.dev) },
      test: { file: 'test.jsonl', sha256: sha256(testText), ...summarize(result.test) },
    },
    audit_sample: { file: 'audit_sample.csv', seed: AUDIT_SEED, size: AUDIT_SIZE, source: 'test.jsonl' },
  };
  await writeFile(join(SETS_DIR, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  console.log('Sets frozen.');
  console.log(`  dev:  ${result.dev.length} questions, by category ${JSON.stringify(countBy(result.dev, (q) => q.category))}`);
  console.log(`  test: ${result.test.length} questions (content not shown), sha256 ${manifest.sets.test.sha256}`);
  console.log(`  verification: ${JSON.stringify(verification)}`);
  console.log(`  max dev/test Jaccard: ${manifest.split.max_dev_test_jaccard}`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
