import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extendDev, maxDocShare, type Candidate } from '../build.ts';
import { DEV_FILE, errorMessage, EVAL_WORK_DIR, loadChunkRefs, SETS_DIR } from '../io.ts';
import {
  ALL_CATEGORIES,
  BEHAVIORS,
  chunkIndex,
  FIELD_ORDER,
  parseJsonl,
  toJsonl,
  validateQuestion,
  type EvalQuestion,
  type QuestionDraft,
} from '../schema.ts';

const TEST_FILE = join(SETS_DIR, 'test.jsonl');
const MANIFEST_FILE = join(SETS_DIR, 'MANIFEST.json');
const VERIFIED_DIR = join(EVAL_WORK_DIR, 'verified');
const EXPECTED_TEST_SHA256 = '44121cce79769bd6c7bb175d307c7e4b8995fa7f858b176f0ce650fb0c5bf9a7';
const NOTE = 'dev v2: extended with verified leftovers before any run';
const OPTIONS = {
  maxNew: 15,
  behaviors: ['abstain', 'handoff', 'decline'] as const,
  maxDocShare: 0.05,
  nearThreshold: 0.6,
  duplicateThreshold: 0.8,
  seed: 20261123,
};

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const normalize = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * One-off, write-once extension of dev.jsonl with verified leftover candidates
 * (non-answer behaviors). test.jsonl is read only by code for the overlap and
 * similarity checks; its content is never printed, and its hash must not change.
 */
async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) as {
    sets: { dev: Record<string, unknown>; test: { sha256: string } };
    [key: string]: unknown;
  };
  if (manifest.sets.dev.version === 2) throw new Error('dev.jsonl was already extended (v2); refusing to extend again.');

  const testText = await readFile(TEST_FILE, 'utf8');
  if (sha256(testText) !== EXPECTED_TEST_SHA256 || manifest.sets.test.sha256 !== EXPECTED_TEST_SHA256) {
    throw new Error('test.jsonl hash does not match the frozen value; aborting.');
  }
  const test = parseJsonl(testText) as EvalQuestion[];
  const devText = await readFile(DEV_FILE, 'utf8');
  const dev = parseJsonl(devText) as EvalQuestion[];

  const index = chunkIndex(await loadChunkRefs());
  const used = new Set([...dev, ...test].map((q) => normalize(q.question)));
  const leftovers: Candidate[] = [];
  for (const file of (await readdir(VERIFIED_DIR)).filter((f) => f.endsWith('.jsonl')).sort()) {
    const lines = parseJsonl(await readFile(join(VERIFIED_DIR, file), 'utf8')) as {
      candidate_id: string;
      verdict: string;
      record?: QuestionDraft;
    }[];
    for (const line of lines) {
      if (line.verdict === 'discard' || !line.record || used.has(normalize(line.record.question))) continue;
      if (validateQuestion(line.record, index, { vendorEmailDomains: ['plausible.io'] }).length > 0) continue;
      leftovers.push({ ...line.record, candidateId: line.candidate_id });
    }
  }
  const leftoverByBehavior = Object.fromEntries(BEHAVIORS.map((b) => [b, leftovers.filter((c) => c.expected_behavior === b).length]));

  const { added, rejected } = extendDev(dev, test, leftovers, index, OPTIONS);
  const extended = [...dev, ...added];
  const ordered = (q: EvalQuestion): Record<string, unknown> => Object.fromEntries(FIELD_ORDER.map((key) => [key, q[key]]));
  const newDevText = devText + toJsonl(added.map(ordered));
  await writeFile(DEV_FILE, newDevText, 'utf8');

  if (sha256(await readFile(TEST_FILE, 'utf8')) !== EXPECTED_TEST_SHA256) throw new Error('test.jsonl changed unexpectedly!');

  manifest.sets.dev = {
    ...manifest.sets.dev,
    version: 2,
    note: NOTE,
    sha256: sha256(newDevText),
    total: extended.length,
    by_behavior: Object.fromEntries(BEHAVIORS.map((b) => [b, extended.filter((q) => q.expected_behavior === b).length])),
    by_category: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, extended.filter((q) => q.category === c).length])),
    max_doc_share: maxDocShare(extended, index),
    v1_sha256: sha256(devText),
    extension: {
      leftovers_available_by_behavior: leftoverByBehavior,
      added: added.length,
      added_ids: added.map((q) => q.id),
      rejected_counts: rejected,
      rules: {
        behaviors: OPTIONS.behaviors,
        max_new: OPTIONS.maxNew,
        doc_cap_share: OPTIONS.maxDocShare,
        no_shared_source_chunks_with_test: true,
        max_jaccard_vs_test_exclusive: OPTIONS.nearThreshold,
      },
    },
  };
  await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`${NOTE}.`);
  console.log(`  leftovers by behavior: ${JSON.stringify(leftoverByBehavior)}`);
  console.log(`  added ${added.length}: ${added.map((q) => `${q.id}(${q.category})`).join(', ')}`);
  console.log(`  rejected (counts only): ${JSON.stringify(rejected)}`);
  console.log(`  dev v2: ${extended.length} questions, by behavior ${JSON.stringify(manifest.sets.dev.by_behavior)}`);
  console.log(`  dev v2 sha256 ${String(manifest.sets.dev.sha256)} | test sha256 unchanged ${EXPECTED_TEST_SHA256}`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
