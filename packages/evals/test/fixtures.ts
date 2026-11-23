import type { Candidate } from '../src/build.ts';
import { chunkIndex, type ChunkIndex, type Category, BEHAVIOR_BY_CATEGORY } from '../src/schema.ts';

export const chunks = [
  { id: 'c_a1', url: 'https://x.test/docs/billing#refunds', doc_path: 'billing.md' },
  { id: 'c_a2', url: 'https://x.test/docs/billing#invoices', doc_path: 'billing.md' },
  { id: 'c_b1', url: 'https://x.test/docs/plans', doc_path: 'plans.md' },
  { id: 'c_c1', url: 'https://x.test/docs/install', doc_path: 'install.md' },
  { id: 'c_d1', url: 'https://x.test/docs/delete-account', doc_path: 'delete-account.md' },
];
export const index: ChunkIndex = chunkIndex(chunks);

let counter = 0;
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');

/** A question text that shares no content words with any other generated one. */
export function uniqueText(): string {
  counter++;
  const a = WORDS[counter % WORDS.length] ?? 'w';
  return `question ${a}${String(counter)} ${a}x${String(counter)} ${a}y${String(counter)}?`;
}

export function answerCandidate(id: string, chunkIds: string[], category: Category = 'billing_account', question = uniqueText()): Candidate {
  const urls = chunkIds.map((c) => chunks.find((x) => x.id === c)?.url ?? '');
  return {
    candidateId: id,
    question,
    answerable: true,
    category,
    expected_behavior: BEHAVIOR_BY_CATEGORY[category],
    expected_urls: urls,
    reference_answer: 'Answer from the docs.',
    key_facts: ['fact'],
    unanswerable_reason: '',
    source_chunk_ids: chunkIds,
  };
}

export function unanswerableCandidate(id: string, category: Category, question = uniqueText()): Candidate {
  return {
    candidateId: id,
    question,
    answerable: false,
    category,
    expected_behavior: BEHAVIOR_BY_CATEGORY[category],
    expected_urls: [],
    reference_answer: 'Say the docs do not cover it and offer a human.',
    key_facts: [],
    unanswerable_reason: 'Not in the docs.',
    source_chunk_ids: [],
  };
}
