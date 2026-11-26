import { describe, expect, it } from 'vitest';
import type { CandidateHit, CandidateLists } from '@groundline/db';
import { assertSetAllowed, evaluateRetrieval, rankCandidates, resolveFinalSet, runSummaryMarkdown } from '../src/retrieval.ts';
import { toQuestion, type Category } from '../src/schema.ts';
import { answerCandidate, unanswerableCandidate } from './fixtures.ts';

const hit = (chunkId: number, url: string, score: number, cosine: number | null): CandidateHit => ({
  chunkId,
  ord: 0,
  url,
  score,
  cosine,
  headingPath: `H${chunkId}`,
  content: '',
  documentTitle: 'Doc',
});

const lists = (vector: CandidateHit[], fullText: CandidateHit[]): CandidateLists => ({ vector, fullText });

describe('assertSetAllowed', () => {
  it('refuses the test set and unknown sets', () => {
    expect(() => {
      assertSetAllowed('test');
    }).toThrow(/Refusing to run on the test set/);
    expect(() => {
      assertSetAllowed('train');
    }).toThrow(/Unknown set/);
    expect(() => {
      assertSetAllowed('dev');
    }).not.toThrow();
  });
});

describe('resolveFinalSet', () => {
  it('opens the test set only with --final, and --final only for the test set', () => {
    expect(() => resolveFinalSet('test', false)).toThrow(/without --final/);
    expect(resolveFinalSet('test', true)).toBe('test');
    expect(resolveFinalSet('dev', false)).toBe('dev');
    expect(() => resolveFinalSet('dev', true)).toThrow(/only to --set test/);
    expect(() => resolveFinalSet('train', false)).toThrow(/Unknown set/);
  });
});

describe('rankCandidates', () => {
  const l = lists(
    [hit(1, 'u1', 0.8, 0.8), hit(2, 'u2', 0.7, 0.7), hit(3, 'u3', 0.6, 0.6)],
    [hit(3, 'u3', 2, 0.6), hit(4, 'u4', 1, 0.5)],
  );
  it('returns each list as is for vector and fts modes, truncated to topN', () => {
    expect(rankCandidates(l, { mode: 'vector', rrfK: 60, candidates: 20, topN: 2 }).map((r) => r.chunkId)).toEqual([1, 2]);
    const fts = rankCandidates(l, { mode: 'fts', rrfK: 60, candidates: 20, topN: 8 });
    expect(fts.map((r) => r.chunkId)).toEqual([3, 4]);
    expect(fts[0]).toMatchObject({ vectorRank: 3, ftsRank: 1, cosine: 0.6, rrfScore: null });
  });

  it('fuses with RRF in hybrid mode and exposes per-list ranks and cosine', () => {
    const hybrid = rankCandidates(l, { mode: 'hybrid', rrfK: 60, candidates: 20, topN: 8 });
    expect(hybrid.map((r) => r.chunkId)).toEqual([3, 1, 2, 4]);
    expect(hybrid[0]).toMatchObject({ rank: 1, vectorRank: 3, ftsRank: 1, vectorScore: 0.6, ftsScore: 2, cosine: 0.6 });
    expect(hybrid[0]?.rrfScore).toBeCloseTo(1 / 63 + 1 / 61, 12);
  });
});

describe('evaluateRetrieval', () => {
  const q = (id: string, c: ReturnType<typeof answerCandidate>) => toQuestion(id, c);
  const unans = (id: string, cat: Category) => toQuestion(id, unanswerableCandidate(id, cat));

  it('scores only "answer" questions and computes AUC on answer vs abstain only', () => {
    const answer1 = q('dev-001', { ...answerCandidate('a', ['c_a1']) });
    const answer2 = q('dev-002', { ...answerCandidate('b', ['c_b1']) });
    const items = [
      // hit at rank 1 (section)
      { question: answer1, lists: lists([hit(1, 'https://x.test/docs/billing#refunds', 0.8, 0.8)], []) },
      // document-level hit only, at rank 2
      { question: answer2, lists: lists([hit(5, 'https://x.test/docs/other', 0.75, 0.75), hit(6, 'https://x.test/docs/plans#x', 0.7, 0.7)], []) },
      { question: unans('dev-003', 'not_covered'), lists: lists([hit(7, 'u', 0.6, 0.6)], []) },
      { question: unans('dev-004', 'off_topic'), lists: lists([hit(8, 'u', 0.5, 0.5)], []) },
      // handoff/decline have high similarity but must not affect the AUC
      { question: unans('dev-005', 'account_action'), lists: lists([hit(9, 'u', 0.95, 0.95)], []) },
      { question: unans('dev-006', 'prompt_injection'), lists: lists([hit(10, 'u', 0.2, 0.2)], []) },
    ];
    const run = evaluateRetrieval(items, { mode: 'vector', rrfK: 60, candidates: 20, topN: 8 });
    expect(run.metrics.answerQuestions).toBe(2);
    expect(run.metrics.section.recall['1']?.hits).toBe(1);
    expect(run.metrics.section.recall['8']?.hits).toBe(1);
    expect(run.metrics.document.recall['8']?.hits).toBe(2);
    expect(run.metrics.document.mrr).toBeCloseTo((1 + 1 / 2) / 2, 12);
    expect(run.metrics.signal.aucAnswerVsAbstain).toMatchObject({ value: 1, nAnswer: 2, nAbstain: 2, resamples: 2000 });
    const tv = run.metrics.signal.thresholdView;
    expect(tv.abstainP90).toBeCloseTo(0.59, 12); // type-7 quantile of [0.5, 0.6]
    expect(tv.answerP10).toBeCloseTo(0.755, 12); // of [0.75, 0.8]
    expect(tv).toMatchObject({ answerMedian: 0.775, abstainMedian: 0.55, answerBelowAbstainP90: 0 });
    expect(run.metrics.signal.distributions.handoff).toMatchObject({ n: 1, median: 0.95 });
    expect(run.metrics.signal.distributions.decline).toMatchObject({ n: 1, median: 0.2 });
    expect(run.perQuestion[2]).toMatchObject({ first_hit_rank_section: null, max_cosine: 0.6 });
    expect(Object.keys(run.metrics.section.recall)).toEqual(['1', '3', '5', '8']);

    const md = runSummaryMarkdown(run, { set: 'dev', label: '', createdAt: '2026-11-23T00:00:00Z' });
    expect(md).toContain('| section | 50.0%');
    expect(md).toContain('Max-cosine AUC (answer vs abstain): 1.0000');
  });

  it('limits recall@k to k <= topN', () => {
    const run = evaluateRetrieval([], { mode: 'hybrid', rrfK: 60, candidates: 20, topN: 3 });
    expect(Object.keys(run.metrics.section.recall)).toEqual(['1', '3']);
  });
});
