import { describe, expect, it } from 'vitest';
import { buildSets, jaccard, maxCrossSimilarity, maxDocShare, questionTokens, type BuildOptions } from '../src/build.ts';
import { validateQuestion } from '../src/schema.ts';
import { answerCandidate, index, unanswerableCandidate } from './fixtures.ts';

const withoutId = <T extends { candidateId: string }>(c: T): Omit<T, 'candidateId'> => {
  const { candidateId: _id, ...rest } = c;
  return rest;
};

describe('validateQuestion', () => {
  it('accepts well-formed questions of every behavior', () => {
    expect(validateQuestion(withoutId(answerCandidate('a', ['c_a1'])), index)).toEqual([]);
    expect(validateQuestion(withoutId(unanswerableCandidate('b', 'not_covered')), index)).toEqual([]);
    expect(validateQuestion(withoutId(unanswerableCandidate('c', 'prompt_injection')), index)).toEqual([]);
    // handoff may carry documented self-service URLs
    const handoff = {
      ...withoutId(unanswerableCandidate('d', 'account_action')),
      expected_urls: ['https://x.test/docs/delete-account'],
      source_chunk_ids: ['c_d1'],
      key_facts: ['You can delete the account in settings.'],
    };
    expect(validateQuestion(handoff, index)).toEqual([]);
  });

  it('rejects inconsistent behavior, unknown URLs/chunks and real-looking emails', () => {
    const bad = { ...withoutId(answerCandidate('a', ['c_a1'])), expected_behavior: 'abstain' };
    expect(validateQuestion(bad, index).join()).toMatch(/expected_behavior must be "answer"/);
    expect(validateQuestion({ ...withoutId(answerCandidate('a', ['c_a1'])), expected_urls: ['https://x.test/nope'] }, index).join()).toMatch(
      /unknown expected_url/,
    );
    expect(validateQuestion({ ...withoutId(answerCandidate('a', ['c_a1'])), source_chunk_ids: ['c_zz'] }, index).join()).toMatch(
      /unknown source_chunk_id/,
    );
    const decline = { ...withoutId(unanswerableCandidate('x', 'competitor')), expected_urls: ['https://x.test/docs/plans'] };
    expect(validateQuestion(decline, index).join()).toMatch(/must not have expected_urls/);
    const email = { ...withoutId(answerCandidate('a', ['c_a1'])), question: 'change my email to jane@gmail.com please' };
    expect(validateQuestion(email, index).join()).toMatch(/non-example email/);
    const ok = { ...withoutId(answerCandidate('a', ['c_a1'])), question: 'change my email to jane@example.com please' };
    expect(validateQuestion(ok, index)).toEqual([]);
    expect(validateQuestion({ ...withoutId(answerCandidate('a', ['c_a1'])), category: 'weather' }, index).join()).toMatch(/unknown category/);
  });
});

describe('similarity helpers', () => {
  it('ignores case, punctuation and stopwords', () => {
    expect(jaccard(questionTokens('How do I cancel my plan?'), questionTokens('cancel plan'))).toBe(1);
    expect(jaccard(questionTokens('cancel plan'), questionTokens('export stats'))).toBe(0);
  });
});

function options(targets: BuildOptions['targets'], docCap = { dev: 3, test: 6 }): BuildOptions {
  return { seed: 1, targets, docCap, duplicateThreshold: 0.8, nearThreshold: 0.6 };
}

describe('buildSets', () => {
  it('meets category targets and assigns sequential ids', () => {
    const cands = [
      ...Array.from({ length: 6 }, (_, i) => answerCandidate(`a${i}`, [i % 2 ? 'c_b1' : 'c_c1'], 'install_integrations')),
      ...Array.from({ length: 3 }, (_, i) => unanswerableCandidate(`u${i}`, 'off_topic')),
    ];
    // Answers sharing a chunk form one group of 3 per chunk (c_b1, c_c1); a group moves as a unit.
    const result = buildSets(cands, index, options({ dev: { install_integrations: 3, off_topic: 1 }, test: { install_integrations: 3, off_topic: 2 } }));
    expect(result.shortfalls).toEqual([]);
    expect(result.dev.map((q) => q.id)).toEqual(['dev-001', 'dev-002', 'dev-003', 'dev-004']);
    expect(result.test.filter((q) => q.category === 'off_topic')).toHaveLength(2);
  });

  it('keeps questions that share a source chunk in the same set', () => {
    const cands = [answerCandidate('a', ['c_a1']), answerCandidate('b', ['c_a1']), answerCandidate('c', ['c_b1'])];
    const result = buildSets(cands, index, options({ dev: { billing_account: 2 }, test: { billing_account: 2 } }));
    const devChunks = result.dev.flatMap((q) => q.source_chunk_ids);
    const testChunks = result.test.flatMap((q) => q.source_chunk_ids);
    expect(devChunks.filter((c) => testChunks.includes(c))).toEqual([]);
    // a and b (both on c_a1) always land together.
    const sets = [result.dev, result.test].map((s) => s.filter((q) => q.source_chunk_ids.includes('c_a1')).length);
    expect(sets.sort()).toEqual([0, 2]);
  });

  it('enforces the per-document cap and reports shortfalls', () => {
    const cands = Array.from({ length: 5 }, (_, i) => answerCandidate(`a${i}`, [i % 2 ? 'c_a1' : 'c_a2']));
    // Both chunks belong to billing.md; cap 2 per set.
    const result = buildSets(cands, index, options({ dev: { billing_account: 5 }, test: { billing_account: 0 } }, { dev: 2, test: 2 }));
    expect(maxDocShare(result.dev, index).count).toBeLessThanOrEqual(2);
    expect(result.shortfalls.some((s) => s.set === 'dev' && s.category === 'billing_account')).toBe(true);
  });

  it('drops near-duplicates and never splits similar questions across sets', () => {
    const cands = [
      answerCandidate('a', ['c_b1'], 'billing_account', 'how can I cancel my plausible subscription today'),
      answerCandidate('b', ['c_c1'], 'billing_account', 'How can I cancel my Plausible subscription today?'),
      answerCandidate('c', ['c_a2'], 'billing_account', 'how can I cancel my plausible subscription next month'),
      answerCandidate('d', ['c_d1'], 'billing_account', 'where are my invoices stored'),
    ];
    const result = buildSets(cands, index, options({ dev: { billing_account: 2 }, test: { billing_account: 1 } }));
    expect(result.duplicatesDropped).toHaveLength(1);
    expect(maxCrossSimilarity(result.dev, result.test)).toBeLessThan(0.6);
  });

  it('is deterministic for a seed', () => {
    const cands = Array.from({ length: 8 }, (_, i) => unanswerableCandidate(`u${i}`, 'not_covered'));
    const opts = options({ dev: { not_covered: 3 }, test: { not_covered: 3 } });
    expect(buildSets(cands, index, opts).dev.map((q) => q.question)).toEqual(buildSets(cands, index, opts).dev.map((q) => q.question));
  });
});
