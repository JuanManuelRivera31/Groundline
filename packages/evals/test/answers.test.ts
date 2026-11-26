import { describe, expect, it } from 'vitest';
import {
  aggregate,
  arrivalOffsets,
  behaviorCorrect,
  computeCodeMetrics,
  judgeItemFromRecord,
  liveSummary,
  parseCsv,
  parseExternalAnswers,
  proportion,
  validateJudgments,
  cohenKappa,
  isJudgedFailure,
  judgeAgreement,
  sampleForSecondJudge,
  stratifiedSecondJudgeSample,
  verdictAgreement,
  type AnswerRecord,
  type JudgeItem,
  type Judgment,
} from '../src/answers.ts';
import { mulberry32 } from '@groundline/core';
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
    model_status: status === 'unavailable' ? null : status,
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
    expect(m.confusion.answer).toEqual({ answered: 1, insufficient: 1, handoff: 0, declined: 0, unavailable: 0 });
    expect(m.confusion.decline).toEqual({ answered: 0, insufficient: 0, handoff: 0, declined: 0, unavailable: 0 });
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
    expect(m.latencyMs.firstAttempt.n).toBe(3);
    expect(m.retriedAnswers).toBe(0);
    const retried = computeCodeMetrics([
      record('r1', 'answer', 'answered', { usage: { generationRequests: 3, promptTokens: 1, outputTokens: 1, thoughtsTokens: 0, embeddingTokens: 1 } }),
    ]);
    expect(retried.retriedAnswers).toBe(1);
    expect(retried.latencyMs.firstAttempt.n).toBe(0);
    expect(m.latencyMs.all.max).toBe(9100);
    expect(m.queueWaitMs).toBe(4000);
    expect(m.tokens).toMatchObject({ modelCalls: 3, meanPrompt: 2000 });
    expect(m.generationRequests).toBe(3);
    expect(m.costUsd.total).toBeCloseTo(0.003001, 9);
  });
});

describe('live time and availability summary', () => {
  it('times every response but only model-delivered ones for delivered latency', () => {
    const lat = (totalMs: number) => ({ retrievalMs: 10, generationMs: totalMs - 10, totalMs, queueWaitMs: 0 });
    const m = computeCodeMetrics([
      record('d1', 'answer', 'answered', { mode: 'live', answered_by: 'm1', latency: lat(2000) }),
      record('d2', 'abstain', 'insufficient', { mode: 'live', answered_by: 'm2', latency: lat(3000) }),
      record('f1', 'abstain', 'insufficient', { mode: 'live', answered_by: null, floor_hit: true, latency: lat(20) }),
      record('u1', 'answer', 'unavailable', { mode: 'live', answered_by: null, latency: lat(7520) }),
    ]);
    expect(m.latencyMs.delivered).toMatchObject({ n: 2, max: 3000 });
    expect(m.latencyMs.all).toMatchObject({ n: 4, max: 7520 });
    expect(liveSummary(m)).toMatchObject({ n: 4, deliveredN: 2, responseP95Ms: m.latencyMs.all.p95, unavailable: { hits: 1, n: 4 } });
    // Records before S5d store no embedding time.
    expect(liveSummary(m)).toMatchObject({ embeddingN: 0 });
  });

  it('counts hedged questions, their winners, cancelled attempts and the embedding latency (S5d)', () => {
    const lat = (totalMs: number, embeddingMs: number) => ({ retrievalMs: embeddingMs + 10, embeddingMs, generationMs: totalMs - embeddingMs - 10, totalMs, queueWaitMs: 0 });
    const m = computeCodeMetrics([
      record('h1', 'answer', 'answered', {
        mode: 'live',
        answered_by: 'm2',
        hops: 1,
        hedged: true,
        latency: lat(4200, 400),
        attempts: [
          { model: 'm2', status: 200, outcome: 'ok', ms: 1000 },
          { model: 'm1', status: 0, outcome: 'cancelled', ms: 4000 },
        ],
      }),
      record('h2', 'answer', 'answered', { mode: 'live', answered_by: 'm1', hops: 0, hedged: false, latency: lat(1500, 600), attempts: [{ model: 'm1', status: 200, outcome: 'ok', ms: 1000 }] }),
    ]);
    expect(m.availability).toMatchObject({ hedged: 1, hedgedAnsweredBy: { m2: 1 }, attemptsByModel: { m1: { cancelled: 1, '200': 1 }, m2: { '200': 1 } } });
    expect(m.latencyMs.embedding).toMatchObject({ n: 2, max: 600 });
    expect(liveSummary(m)).toMatchObject({ embeddingN: 2 });
  });
});

describe('arrivalOffsets', () => {
  it('is deterministic, starts at 0, never goes back in time and has the requested mean gap', () => {
    const a = arrivalOffsets(30, 12_000, mulberry32(20261125));
    expect(a).toEqual(arrivalOffsets(30, 12_000, mulberry32(20261125)));
    expect(a[0]).toBe(0);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1] ?? 0);
    const many = arrivalOffsets(20_001, 12_000, mulberry32(7));
    expect((many.at(-1) ?? 0) / 20_000).toBeGreaterThan(11_500);
    expect((many.at(-1) ?? 0) / 20_000).toBeLessThan(12_500);
  });
});

describe('availability and quote-length metrics', () => {
  it('counts unavailable, answering models, hops, attempts and fallbacks; tolerates S3 records', () => {
    const m = computeCodeMetrics([
      record('l1', 'answer', 'answered', {
        mode: 'live',
        answered_by: 'm2',
        hops: 1,
        attempts: [
          { model: 'm1', status: 503, outcome: 'http_error', ms: 300 },
          { model: 'm2', status: 200, outcome: 'ok', ms: 900 },
        ],
        retrieval_fallback: 'vector',
        citations: [cite('https://x.test/docs/a#s1')],
        invalid_citations: [{ marker: 2, source_id: 'S1', quote: Array.from({ length: 90 }, () => 'w').join(' '), reason: 'quote_too_long' }],
      }),
      record('l2', 'answer', 'unavailable', {
        mode: 'live',
        answered_by: null,
        hops: 1,
        attempts: [
          { model: 'm1', status: null, outcome: 'quota_local', ms: 0 },
          { model: 'm2', status: 0, outcome: 'timeout', ms: 7000 },
        ],
        retrieval_fallback: 'vector',
      }),
      record('l3', 'abstain', 'unavailable', { usage: { generationRequests: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, embeddingTokens: 3 }, retrieval_fallback: 'fts', attempts: [] }),
      record('s3', 'answer', 'answered'),
    ]);
    expect(m.availability.unavailable).toMatchObject({ hits: 2, n: 4 });
    expect(m.availability.answeredBy).toEqual({ m2: 1 });
    expect(m.availability.hops).toEqual({ '0': 1, '1': 2 });
    expect(m.availability.attemptsByModel).toEqual({ m1: { '503': 1, 'local:quota_local': 1 }, m2: { '200': 1, '0': 1 } });
    expect(m.availability.retrievalFallback).toEqual({ vector: 3, fts: 1 });
    expect(m.confusion.answer.unavailable).toBe(1);
    expect(m.behavior.byExpected.abstain).toMatchObject({ hits: 0, n: 1 });
    expect(m.quoteWords.all).toMatchObject({ n: 2, min: 1, max: 90 });
    expect(m.quoteWords.valid).toMatchObject({ n: 1 });
    expect(m.quoteWords).toMatchObject({ over40: 1, over80: 1 });
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
    const live = { n: 30, responseP95Ms: 9100, deliveredP95Ms: 4000, deliveredN: 20, unavailable: proportion(1, 30), embeddingP95Ms: 0, embeddingN: 0 };
    const result = aggregate(items, judgments, computeCodeMetrics(records), live);
    const byKey = Object.fromEntries(result.targets.map((t) => [t.key, t]));
    expect(byKey.fabricated?.value).toMatchObject({ hits: 2, n: 3 });
    expect(byKey.fabricated?.met).toBe(false);
    expect(byKey.idkCorrect?.value).toMatchObject({ hits: 1, n: 2 });
    expect(byKey.correctAnswers?.value).toMatchObject({ hits: 1, n: 2 });
    expect(byKey.citationsCorrect?.value).toMatchObject({ hits: 1, n: 2 });
    // Time and availability come from the live run; eval latency without retries is informational.
    expect(byKey.responseTimeP95Ms).toMatchObject({ value: 9100, met: false, target: '≤ 8 s' });
    expect(byKey.deliveredLatencyP95Ms).toMatchObject({ value: 4000, met: null });
    expect(byKey.unavailableRate).toMatchObject({ value: { hits: 1, n: 30 }, met: true, target: '≤ 5%' });
    expect(byKey.modelLatencyP95Ms).toMatchObject({ value: 1000, met: null, target: '—' });
    const noLive = aggregate(items, judgments, computeCodeMetrics(records));
    expect(noLive.targets.map((t) => t.key)).not.toContain('responseTimeP95Ms');
    expect(result.judge.completeMean).toBe(1);
    expect(result.judge.appropriateOnNonAnswered).toMatchObject({ hits: 1, n: 1 });
  });

  it('checks realistic live runs against the targets and keeps stress runs informational', () => {
    const { judgments } = validateJudgments(items, good);
    // The realistic run embedded every question live (S5d): its embedding latency is an informational row.
    const realistic = { n: 30, responseP95Ms: 7600, deliveredP95Ms: 5000, deliveredN: 25, unavailable: proportion(2, 30), embeddingP95Ms: 900, embeddingN: 30 };
    const burst = { n: 30, responseP95Ms: 9000, deliveredP95Ms: 6000, deliveredN: 20, unavailable: proportion(6, 30), embeddingP95Ms: 0, embeddingN: 0 };
    const rows = aggregate(items, judgments, computeCodeMetrics(records), realistic, burst).targets.slice(-7);
    expect(rows.map((t) => [t.key, t.met])).toEqual([
      ['responseTimeP95Ms', true],
      ['deliveredLatencyP95Ms', null],
      ['unavailableRate', false],
      ['embeddingLatencyP95Ms', null],
      ['responseTimeP95Ms', null],
      ['deliveredLatencyP95Ms', null],
      ['unavailableRate', null],
    ]);
    expect(rows[3]).toMatchObject({ value: 900, target: '—' });
    expect(rows[3]?.label).toContain('Query embedding latency p95 (live, realistic arrivals, n=30');
    expect(rows[4]?.label).toContain('stress burst');
    expect(rows[0]?.label).toContain('realistic arrivals, n=30');
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

describe('second judge', () => {
  const ids = Array.from({ length: 50 }, (_, i) => ({ id: `t-${String(i).padStart(3, '0')}` }));

  it('draws a deterministic sample of n items in their original order', () => {
    const a = sampleForSecondJudge(ids, 30, 20261126);
    expect(a).toHaveLength(30);
    expect(a).toEqual(sampleForSecondJudge(ids, 30, 20261126));
    expect(a.map((x) => x.id)).toEqual([...a.map((x) => x.id)].sort());
    expect(sampleForSecondJudge(ids, 30, 1)).not.toEqual(a);
  });

  it("computes Cohen's kappa for binary verdicts", () => {
    expect(cohenKappa([[true, true], [false, false], [true, true], [false, false]])).toBe(1);
    expect(cohenKappa([[true, false], [false, true]])).toBe(-1);
    expect(cohenKappa([[true, true], [true, true]])).toBeNull();
    expect(cohenKappa([])).toBeNull();
  });

  it('draws every first-judge failure plus a seeded sample of passing items, and scores the overall verdict', () => {
    const mk = (id: string, over: Partial<Judgment>): Judgment => ({
      id,
      judge_model: 'x',
      correct: null,
      unsupported_claims: null,
      unsupported_examples: [],
      complete: null,
      appropriate: null,
      rationale: '',
      ...over,
    });
    const items = Array.from({ length: 40 }, (_, i) => judgeItemFromRecord(record(`s-${String(i).padStart(2, '0')}`, 'answer', 'answered')));
    const first = items.map((it, i) =>
      i === 3 ? mk(it.id, { correct: false, unsupported_claims: 0 }) : i === 7 ? mk(it.id, { correct: true, unsupported_claims: 1 }) : i === 9 ? mk(it.id, { appropriate: false }) : mk(it.id, { correct: true, unsupported_claims: 0 }),
    );
    expect(first.filter(isJudgedFailure).map((j) => j.id)).toEqual(['s-03', 's-07', 's-09']);
    const strata = stratifiedSecondJudgeSample(items, first, 20, 20261127);
    expect(strata.failures).toEqual(['s-03', 's-07', 's-09']);
    expect(strata.correct).toHaveLength(20);
    expect(strata.correct.some((id) => strata.failures.includes(id))).toBe(false);
    expect(stratifiedSecondJudgeSample(items, first, 20, 20261127)).toEqual(strata);
    // The second judge confirms two failures, clears one and fails one passing item.
    const second = first.map((j) => (j.id === 's-07' ? { ...j, unsupported_claims: 0 } : j.id === strata.correct[0] ? { ...j, correct: false } : j));
    const all = [...strata.failures, ...strata.correct];
    const v = verdictAgreement(all, first, second);
    expect(v.agreement).toMatchObject({ hits: 21, n: 23 });
    expect(v.disagreements).toEqual([
      { id: 's-07', first: 'fail', second: 'pass' },
      { id: strata.correct[0], first: 'pass', second: 'fail' },
    ]);
    expect(v.kappa).toBeCloseTo((21 / 23 - ((3 / 23) * (3 / 23) + (20 / 23) * (20 / 23))) / (1 - ((3 / 23) * (3 / 23) + (20 / 23) * (20 / 23))), 10);
  });

  it('compares correct, unsupported claims and appropriate between judges', () => {
    const item = (id: string, status: JudgeItem['status']): JudgeItem => ({
      id,
      mode: 'internal',
      question: 'q',
      expected_behavior: status === 'answered' ? 'answer' : 'abstain',
      reference_answer: 'r',
      key_facts: [],
      status,
      answer: 'a',
      citations: [],
      evidence: [],
    });
    const j = (id: string, over: Partial<Judgment>): Judgment => ({
      id,
      judge_model: 'x',
      correct: null,
      unsupported_claims: null,
      unsupported_examples: [],
      complete: null,
      appropriate: null,
      rationale: '',
      ...over,
    });
    const items = [item('a1', 'answered'), item('a2', 'answered'), item('a3', 'answered'), item('n1', 'insufficient')];
    const first = [j('a1', { correct: true, unsupported_claims: 0 }), j('a2', { correct: true, unsupported_claims: 0 }), j('a3', { correct: false, unsupported_claims: 1 }), j('n1', { appropriate: true })];
    const second = [j('a1', { correct: true, unsupported_claims: 0 }), j('a2', { correct: false, unsupported_claims: 0 }), j('a3', { correct: false, unsupported_claims: 2 }), j('n1', { appropriate: true })];
    const r = judgeAgreement(items, first, second);
    expect(r).toMatchObject({ n: 4, answered: 3 });
    expect(r.correct.agreement).toMatchObject({ hits: 2, n: 3 });
    expect(r.unsupportedAny.agreement).toMatchObject({ hits: 3, n: 3 });
    expect(r.unsupportedAny.kappa).toBe(1);
    expect(r.unsupportedExact).toMatchObject({ hits: 2, n: 3 });
    expect(r.appropriate.agreement).toMatchObject({ hits: 1, n: 1 });
    expect(r.disagreements.map((d) => [d.id, d.field])).toEqual([
      ['a2', 'correct'],
      ['a3', 'unsupported_claims'],
    ]);
  });
});
