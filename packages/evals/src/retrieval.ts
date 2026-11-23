import { fuseRrf } from '@groundline/core';
import type { CandidateHit, CandidateLists } from '@groundline/db';
import {
  bootstrapAuc,
  distribution,
  firstHitRank,
  rankMetrics,
  type Distribution,
  type Interval,
  type RankMetrics,
} from './metrics.ts';
import { BEHAVIORS, type EvalQuestion, type ExpectedBehavior } from './schema.ts';

export type RetrievalMode = 'vector' | 'fts' | 'hybrid';
export const RETRIEVAL_MODES: readonly RetrievalMode[] = ['vector', 'fts', 'hybrid'];

export interface RetrievalConfig {
  readonly mode: RetrievalMode;
  /** RRF damping constant (hybrid only). */
  readonly rrfK: number;
  /** Candidates fetched per list (vector and full-text). */
  readonly candidates: number;
  /** Results returned to the caller (what the model sees in S3). */
  readonly topN: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: Omit<RetrievalConfig, 'mode'> = { rrfK: 60, candidates: 20, topN: 8 };
export const RECALL_KS: readonly number[] = [1, 3, 5, 8];

/** Only the dev set may be used in this session (CLAUDE.md rule on test.jsonl). */
export function assertSetAllowed(set: string): asserts set is 'dev' {
  if (set === 'test') {
    throw new Error(
      'Refusing to run on the test set: "Never read, print or use evals/plausible/test.jsonl to tune anything. ' +
        'Only the final run command reads it, with explicit owner approval." (CLAUDE.md). Use --set dev.',
    );
  }
  if (set !== 'dev') throw new Error(`Unknown set "${set}". Use --set dev.`);
}

export interface RetrievedItem {
  readonly rank: number;
  readonly chunkId: number;
  readonly url: string;
  readonly headingPath: string;
  readonly cosine: number | null;
  readonly vectorRank: number | null;
  readonly ftsRank: number | null;
  readonly vectorScore: number | null;
  readonly ftsScore: number | null;
  readonly rrfScore: number | null;
}

/** Ranked results for one question in the given mode. */
export function rankCandidates(lists: CandidateLists, config: RetrievalConfig): RetrievedItem[] {
  const vectorRank = new Map(lists.vector.map((h, i) => [h.chunkId, i + 1]));
  const ftsRank = new Map(lists.fullText.map((h, i) => [h.chunkId, i + 1]));
  const vectorScore = new Map(lists.vector.map((h) => [h.chunkId, h.score]));
  const ftsScore = new Map(lists.fullText.map((h) => [h.chunkId, h.score]));
  const cosineOf = new Map<number, number | null>();
  for (const h of [...lists.vector, ...lists.fullText]) if (!cosineOf.has(h.chunkId) || cosineOf.get(h.chunkId) === null) cosineOf.set(h.chunkId, h.cosine);

  const describe = (hit: CandidateHit, rank: number, rrfScore: number | null): RetrievedItem => ({
    rank,
    chunkId: hit.chunkId,
    url: hit.url,
    headingPath: hit.headingPath,
    cosine: cosineOf.get(hit.chunkId) ?? null,
    vectorRank: vectorRank.get(hit.chunkId) ?? null,
    ftsRank: ftsRank.get(hit.chunkId) ?? null,
    vectorScore: vectorScore.get(hit.chunkId) ?? null,
    ftsScore: ftsScore.get(hit.chunkId) ?? null,
    rrfScore,
  });

  switch (config.mode) {
    case 'vector':
      return lists.vector.slice(0, config.topN).map((h, i) => describe(h, i + 1, null));
    case 'fts':
      return lists.fullText.slice(0, config.topN).map((h, i) => describe(h, i + 1, null));
    case 'hybrid':
      return fuseRrf(
        [
          { name: 'vector', items: lists.vector },
          { name: 'fts', items: lists.fullText },
        ],
        { k: config.rrfK, limit: config.topN },
      ).map((f, i) => describe(f.item, i + 1, f.rrfScore));
  }
}

export interface QuestionResult {
  readonly id: string;
  readonly category: string;
  readonly expected_behavior: ExpectedBehavior;
  readonly question: string;
  readonly expected_urls: readonly string[];
  /** Highest cosine among the vector candidates (the "I don't know" signal). */
  readonly max_cosine: number | null;
  readonly first_hit_rank_document: number | null;
  readonly first_hit_rank_section: number | null;
  readonly retrieved: readonly RetrievedItem[];
}

export interface RetrievalMetrics {
  readonly answerQuestions: number;
  readonly document: RankMetrics;
  readonly section: RankMetrics;
  readonly signal: {
    /** AUC of max cosine separating "answer" from "abstain" only, with a 95% bootstrap interval. */
    readonly aucAnswerVsAbstain: Interval & { readonly nAnswer: number; readonly nAbstain: number; readonly resamples: number; readonly seed: number };
    readonly distributions: Readonly<Record<ExpectedBehavior, Distribution>>;
  };
}

export interface RetrievalRun {
  readonly config: RetrievalConfig;
  readonly metrics: RetrievalMetrics;
  readonly perQuestion: readonly QuestionResult[];
}

export const BOOTSTRAP = { resamples: 2000, seed: 20261123 } as const;

export function evaluateRetrieval(
  items: readonly { readonly question: EvalQuestion; readonly lists: CandidateLists }[],
  config: RetrievalConfig,
): RetrievalRun {
  const perQuestion: QuestionResult[] = items.map(({ question, lists }) => {
    const retrieved = rankCandidates(lists, config);
    const urls = retrieved.map((r) => r.url);
    const cosines = lists.vector.map((h) => h.cosine).filter((c): c is number => c !== null);
    const answer = question.expected_behavior === 'answer';
    return {
      id: question.id,
      category: question.category,
      expected_behavior: question.expected_behavior,
      question: question.question,
      expected_urls: question.expected_urls,
      max_cosine: cosines.length > 0 ? Math.max(...cosines) : null,
      first_hit_rank_document: answer ? firstHitRank(urls, question.expected_urls, 'document') : null,
      first_hit_rank_section: answer ? firstHitRank(urls, question.expected_urls, 'section') : null,
      retrieved,
    };
  });

  const answered = perQuestion.filter((q) => q.expected_behavior === 'answer');
  const ks = RECALL_KS.filter((k) => k <= config.topN);
  const signalOf = (behavior: ExpectedBehavior): number[] =>
    perQuestion.filter((q) => q.expected_behavior === behavior && q.max_cosine !== null).map((q) => q.max_cosine ?? 0);

  const answerSignal = signalOf('answer');
  const abstainSignal = signalOf('abstain');
  const distributions = Object.fromEntries(BEHAVIORS.map((b) => [b, distribution(signalOf(b))])) as Record<ExpectedBehavior, Distribution>;

  return {
    config,
    metrics: {
      answerQuestions: answered.length,
      document: rankMetrics(answered.map((q) => q.first_hit_rank_document), ks),
      section: rankMetrics(answered.map((q) => q.first_hit_rank_section), ks),
      signal: {
        aucAnswerVsAbstain: {
          ...bootstrapAuc(answerSignal, abstainSignal, BOOTSTRAP),
          nAnswer: answerSignal.length,
          nAbstain: abstainSignal.length,
          ...BOOTSTRAP,
        },
        distributions,
      },
    },
    perQuestion,
  };
}

const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const num = (x: number): string => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');

/** Markdown summary of one run (no document text). */
export function runSummaryMarkdown(run: RetrievalRun, meta: { readonly set: string; readonly label: string; readonly createdAt: string }): string {
  const { config, metrics } = run;
  const lines: string[] = [];
  lines.push(`# Retrieval eval — ${meta.set} — ${config.mode}${meta.label ? ` (${meta.label})` : ''}`);
  lines.push('');
  lines.push(`- Created: ${meta.createdAt}`);
  lines.push(`- Config: mode=${config.mode}, rrfK=${config.rrfK}, candidates=${config.candidates}+${config.candidates}, topN=${config.topN}`);
  lines.push(`- Answerable questions scored: ${metrics.answerQuestions}`);
  lines.push('');
  lines.push('| Level | ' + Object.keys(metrics.section.recall).map((k) => `R@${k} [95% Wilson]`).join(' | ') + ' | MRR |');
  lines.push('| --- | ' + Object.keys(metrics.section.recall).map(() => '---').join(' | ') + ' | --- |');
  for (const [name, m] of [
    ['section', metrics.section],
    ['document', metrics.document],
  ] as const) {
    const cells = Object.values(m.recall).map((r) => `${pct(r.value)} [${pct(r.lo)}–${pct(r.hi)}]`);
    lines.push(`| ${name} | ${cells.join(' | ')} | ${num(m.mrr)} |`);
  }
  const auc = metrics.signal.aucAnswerVsAbstain;
  lines.push('');
  lines.push(
    `Max-cosine AUC (answer vs abstain): ${num(auc.value)} [95% bootstrap ${num(auc.lo)}–${num(auc.hi)}], ` +
      `n=${auc.nAnswer}/${auc.nAbstain}, ${auc.resamples} resamples, seed ${auc.seed}`,
  );
  lines.push('');
  lines.push('| Behavior | n | min | p25 | median | p75 | max |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const [behavior, d] of Object.entries(metrics.signal.distributions)) {
    lines.push(`| ${behavior} | ${d.n} | ${num(d.min)} | ${num(d.p25)} | ${num(d.median)} | ${num(d.p75)} | ${num(d.max)} |`);
  }
  return lines.join('\n') + '\n';
}
