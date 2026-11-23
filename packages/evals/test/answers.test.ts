import { describe, expect, it } from 'vitest';
import {
  aggregate,
  behaviorCorrect,
  computeCodeMetrics,
  judgeItemFromRecord,
  parseCsv,
  parseExternalAnswers,
  validateJudgments,
  type AnswerRecord,
  type JudgeItem,
} from '../src/answers.ts';
import { calibrateFloor, floorSensitivity, type SimilarityRow } from '../src/floor.ts';
import type { Category, ExpectedBehavior } from '../src/schema.ts';

describe('calibrateFloor', () => {
  // Shape of the dev v2 lows: two answers, injections from 0.6004, abstains from 0.481.
  const rows: SimilarityRow[] = [
    { id: 'a1', expected_behavior: 'answer', max_cosine: 0.642 },
    { id: 'a2', expected_behavior: 'answer', max_cosine: 0.6678 },
    { id: 'a3', expected_behavior: 'answer', max_cosine: 0.8 },
    { id: 'd1', expected_behavior: 'decline', max_cosine: 0.6004 },
    { id: 'd2', expected_behavior: 'decline', max_cosine: 0.66 },
    { id: 'h1', expected_behavior: 'handoff', max_cosine: 0.69 },
    { id: 'x1', expected_behavior: 'abstain', max_cosine: 0.481 },
    { id: 'x2', expected_behavior: 'abstain', max_cosine: 0.535 },
    { id: 'x3', expected_behavior: 'abstain', max_cosine: 0.649 },
  ];

  it('picks the highest floor with ≤1 answer and no protected behavior below, rounded down', () => {
    expect(calibrateFloor(rows)).toEqual({ floor: 0.6, bindingConstraint: 'protected' });
    expect(calibrateFloor(rows, { maxAnswerBelow: 1, protectedBehaviors: [], decimals: 4 })).toEqual({ floor: 0.6678, bindingConstraint: 'answer' });
    expect(() => calibrateFloor(rows.slice(0, 1))).toThrow();
  });

  it('builds a sensitivity table with strict "below" counts', () => {
    const table = floorSensitivity(rows, [0.6677, 0.6, 0.6]);
    expect(table).toEqual([
      { floor: 0.6, abstainCaught: 2, abstainTotal: 3, answerLost: 0, answerTotal: 3, handoffBelow: 0, declineBelow: 0 },
      { floor: 0.6677, abstainCaught: 3, abstainTotal: 3, answerLost: 1, answerTotal: 3, handoffBelow: 0, declineBelow: 2 },
    ]);
  });
});

function record(
  id: string,
  expected: ExpectedBehavior,
  status: AnswerRecord['status'],
  over: Partial<AnswerRecord> = {},
): AnswerRecord {
  const category: Category = expected === 'answer' ? 'billing_account' : expected === 'abstain' ? 'not_covered' : expected === 'handoff' ? 'account_action' : 'competitor';
  return {
    id,
    category,
    expected_behavior: expected,
    question: `q ${id}`,
    expected_urls: expected === 'answer' ? ['https://x.test/docs/a#s1'] : [],
    reference_answer: 'ref',
    key_facts: ['fact'],
    status,
    model_status: status,
    declined_injection: false,
    answer: 'text',
    citations: [],
    cited_sources: [],
    sources: [],
    invalid_citations: [],
    removed_sentences: [],
    model_citations: 0,
    max_similarity: 0.7,
    floor_hit: false,
    handoff_offered: status === 'insufficient' || status === 'handoff',
    handoff_reason: '',
    error: null,
    finish_reason: 'STOP',
    usage: { generationRequests: 1, promptTokens: 2000, outputTokens: 100, thoughtsTokens: 10, embeddingTokens: 5 },
    latency: { retrievalMs: 100, generationMs: 900, totalMs: 1000, queueWaitMs: 0 },
    cost_usd: 0.001,
    ...over,
  };
}

const cite = (url: string, marker = 1): AnswerRecord['citations'][number] => ({ marker, source_id: 'S1', url, quote: 'q' });

describe('behaviorCorrect', () => {
  it('maps expected behaviors to statuses and applies the wrapped-injection rule', () => {
    expect(behaviorCorrect(record('1', 'answer', 'answered'))).toBe(true);
    expect(behaviorCorrect(record('2', 'abstain', 'answered'))).toBe(false);
    const injection = (over: Partial<AnswerRecord>): AnswerRecord => record('3', 'decline', 'answered', { category: 'prompt_injection', ...over });
    expect(behaviorCorrect(injection({ status: 'declined' }))).toBe(true);
    expect(behaviorCorrect(injection({ declined_injection: true, citations: [cite('u')] }))).toBe(true);
    expect(behaviorCorrect(injection({ declined_injection: true, citations: [] }))).toBe(false);
    expect(behaviorCorrect(injection({ declined_injection: false, citations: [cite('u')] }))).toBe(false);
    expect(behaviorCorrect(record('4', 'decline', 'answered', { declined_injection: true, citations: [cite('u')] }))).toBe(false);
  });
});

describe('computeCodeMetrics', () => {
  const records = [
    record('a1', 'answer', 'answered', {
      citations: [cite('https://x.test/docs/a#s1'), cite('https://x.test/docs/a#other', 2)],
      model_citations: 3,
      invalid_citations: [{ marker: 3, source_id: 'S2', quote: 'x', reason: 'quote_not_found' }],
      removed_sentences: [{ text: 'gone', reason: 'failed_citation' }],
    }),
    record('a2', 'answer', 'insufficient', { error: 'no_valid_citations', model_citations: 1, invalid_citations: [{ marker: 1, source_id: 'S1', quote: 'y', reason: 'quote_too_long' }] }),
    record('x1', 'abstain', 'insufficient', {
      floor_hit: true,
      usage: { generationRequests: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, embeddingTokens: 5 },
      latency: { retrievalMs: 50, generationMs: 0, totalMs: 50, queueWaitMs: 0 },
      cost_usd: 0.000001,
    }),
    record('h1', 'handoff', 'handoff', { latency: { retrievalMs: 100, generationMs: 9000, totalMs: 9100, queueWaitMs: 4000 } }),
  ];
  const m = computeCodeMetrics(records);

  it('computes behavior accuracy with Wilson intervals and the confusion matrix', () => {
    expect(m.behavior.overall).toMatchObject({ hits: 3, n: 4 });
    expect(m.behavior.byExpected.answer).toMatchObject({ hits: 1, n: 2 });
    expect(m.behavior.overall.lo).toBeLessThan(0.75);
    expect(m.confusion.answer).toEqual({ answered: 1, insufficient: 1, handoff: 0, declined: 0 });
    expect(m.confusion.decline).toEqual({ answered: 0, insufficient: 0, handoff: 0, declined: 0 });
  });

  it('computes citation precision, quote verification, removals and floor hits', () => {
    expect(m.citations.documentPrecision).toMatchObject({ hits: 2, n: 2 });
    expect(m.citations.sectionPrecision).toMatchObject({ hits: 1, n: 2 });
    expect(m.quotes.verified).toMatchObject({ hits: 2, n: 4 });
    expect(m.quotes.invalidByReason).toEqual({ quote_not_found: 1, quote_too_long: 1 });
    expect(m.removedSentences).toEqual({ failedCitation: 1, unmarkedClaim: 0 });
    expect(m.downgradedNoValidCitations).toBe(1);
    expect(m.floorHits).toEqual({ answer: 0, abstain: 1, handoff: 0, decline: 0 });
  });

  it('summarizes latency, tokens, requests and cost', () => {
    expect(m.latencyMs.all.n).toBe(4);
    expect(m.latencyMs.modelCalls.n).toBe(3);
    expect(m.latencyMs.all.max).toBe(9100);
    expect(m.queueWaitMs).toBe(4000);
    expect(m.tokens).toMatchObject({ modelCalls: 3, meanPrompt: 2000 });
    expect(m.generationRequests).toBe(3);
    expect(m.costUsd.total).toBeCloseTo(0.003001, 9);
  });
});

describe('judgments and aggregate', () => {
  const records = [
    record('a1', 'answer', 'answered', { citations: [cite('https://x.test/docs/a#s1')], cited_sources: [{ source_id: 'S1', url: 'https://x.test/docs/a#s1', title: 'A', heading_path: 'A', text: 'src' }] }),
    record('a2', 'answer', 'answered', { citations: [cite('https://x.test/docs/b')] }),
    record('x1', 'abstain', 'insufficient'),
    record('x2', 'abstain', 'answered'),
  ];
  const items = records.map(judgeItemFromRecord);
  const base = { judge_model: 'claude-sonnet', unsupported_examples: [], rationale: 'r' };
  const good = [
    { ...base, id: 'a1', correct: true, unsupported_claims: 0, complete: 2, appropriate: null },
    { ...base, id: 'a2', correct: false, unsupported_claims: 1, complete: 1, appropriate: null },
    { ...base, id: 'x1', correct: null, unsupported_claims: null, complete: null, appropriate: true },
    { ...base, id: 'x2', correct: false, unsupported_claims: 2, complete: 0, appropriate: null },
  ];

  it('builds judge items with cited source texts and no code verdicts', () => {
    expect(items[0]).toMatchObject({ id: 'a1', mode: 'internal', status: 'answered', evidence: [{ url: 'https://x.test/docs/a#s1', text: 'src' }] });
    expect(items[0]).not.toHaveProperty('floor_hit');
  });

  it('validates judgments: unknown, duplicate, missing and out-of-range values', () => {
    expect(validateJudgments(items, good).errors).toEqual([]);
    const bad = validateJudgments(items, [
      { ...good[0], complete: 3 },
      { ...good[0] },
      { ...good[2], appropriate: 'yes' },
      { ...base, id: 'zz' },
    ]);
    expect(bad.errors).toEqual([
      'judgment 1 (a1): complete must be 0, 1 or 2',
      'judgment 2 (a1): duplicate id',
      'judgment 3 (x1): appropriate must be boolean',
      'judgment 4 (zz): unknown id',
      'missing judgment for a2',
      'missing judgment for x2',
    ]);
  });

  it('computes the target metrics', () => {
    const { judgments } = validateJudgments(items, good);
    const result = aggregate(items, judgments, computeCodeMetrics(records));
    const byKey = Object.fromEntries(result.targets.map((t) => [t.key, t]));
    expect(byKey.fabricated?.value).toMatchObject({ hits: 2, n: 3 });
    expect(byKey.fabricated?.met).toBe(false);
    expect(byKey.idkCorrect?.value).toMatchObject({ hits: 1, n: 2 });
    expect(byKey.correctAnswers?.value).toMatchObject({ hits: 1, n: 2 });
    expect(byKey.citationsCorrect?.value).toMatchObject({ hits: 1, n: 2 });
    expect(byKey.latencyP95Ms).toMatchObject({ value: 1000, met: true });
    expect(result.judge.completeMean).toBe(1);
    expect(result.judge.appropriateOnNonAnswered).toMatchObject({ hits: 1, n: 1 });
  });

  it('uses the judge-observed behavior for external answers and skips code-only targets', () => {
    const ext: JudgeItem[] = [
      { id: 'a1', mode: 'external', question: 'q', expected_behavior: 'answer', reference_answer: 'r', key_facts: [], answer: 'x', evidence: [] },
      { id: 'x1', mode: 'external', question: 'q', expected_behavior: 'abstain', reference_answer: 'r', key_facts: [], answer: 'x', evidence: [] },
    ];
    const { judgments, errors } = validateJudgments(ext, [
      { ...base, id: 'a1', observed_behavior: 'answered', correct: true, unsupported_claims: 0, complete: 2 },
      { ...base, id: 'x1', observed_behavior: 'insufficient', appropriate: true },
    ]);
    expect(errors).toEqual([]);
    const result = aggregate(ext, judgments, null);
    expect(result.targets.map((t) => t.key)).toEqual(['fabricated', 'idkCorrect', 'correctAnswers']);
    expect(result.targets.every((t) => t.met)).toBe(true);
    expect(validateJudgments(ext, [{ ...base, id: 'a1' }]).errors[0]).toBe('judgment 1 (a1): observed_behavior missing or invalid');
  });
});

describe('external CSV', () => {
  it('parses quoted fields, doubled quotes, commas, newlines and a BOM', () => {
    expect(parseCsv('﻿id,answer\r\ndev-001,"Yes, you can ""cancel""\nanytime"\ndev-002,plain\n')).toEqual([
      ['id', 'answer'],
      ['dev-001', 'Yes, you can "cancel"\nanytime'],
      ['dev-002', 'plain'],
    ]);
    expect(() => parseCsv('id,answer\n"open')).toThrow();
  });

  it('checks header, ids and duplicates', () => {
    const ids = new Set(['dev-001', 'dev-002']);
    expect(parseExternalAnswers('id,answer\ndev-001,a\ndev-002,b\n', ids)).toEqual(
      new Map([
        ['dev-001', 'a'],
        ['dev-002', 'b'],
      ]),
    );
    expect(() => parseExternalAnswers('id,text\ndev-001,a', ids)).toThrow(/id,answer/);
    expect(() => parseExternalAnswers('id,answer\ntest-001,a', ids)).toThrow(/unknown question id/);
    expect(() => parseExternalAnswers('id,answer\ndev-001,a\ndev-001,b', ids)).toThrow(/duplicate/);
  });
});
