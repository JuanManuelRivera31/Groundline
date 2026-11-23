import { mulberry32, shuffled } from '@groundline/core';
import { ALL_CATEGORIES, toQuestion, type Category, type ChunkIndex, type EvalQuestion, type QuestionDraft } from './schema.ts';

export type SetName = 'dev' | 'test';

export interface Candidate extends QuestionDraft {
  /** Stable candidate id assigned before verification (e.g. "billing_account-007"). */
  readonly candidateId: string;
}

export interface BuildOptions {
  readonly seed: number;
  /** Questions per category in each set. */
  readonly targets: Readonly<Record<SetName, Readonly<Partial<Record<Category, number>>>>>;
  /** Max questions per source document in each set (5% of the set size). */
  readonly docCap: Readonly<Record<SetName, number>>;
  /** Jaccard similarity at or above which two questions are duplicates (one is dropped). */
  readonly duplicateThreshold: number;
  /** Jaccard similarity at or above which two questions must land in the same set. */
  readonly nearThreshold: number;
}

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  seed: 20261123,
  targets: {
    dev: {
      billing_account: 16,
      install_integrations: 14,
      dashboard_metrics: 11,
      api: 4,
      not_covered: 6,
      off_topic: 2,
      competitor: 2,
      account_action: 3,
      prompt_injection: 2,
    },
    test: {
      billing_account: 31,
      install_integrations: 25,
      dashboard_metrics: 20,
      api: 9,
      not_covered: 14,
      off_topic: 5,
      competitor: 5,
      account_action: 6,
      prompt_injection: 5,
    },
  },
  docCap: { dev: 3, test: 6 },
  duplicateThreshold: 0.8,
  nearThreshold: 0.6,
};

const STOPWORDS = new Set(
  'a an and are as at be but by can could do does for from how i if in is it its me my of on or our so that the this to was we what when where which who why will with you your im ive dont cant'.split(' '),
);

export function questionTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[’']/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface BuildResult {
  readonly dev: EvalQuestion[];
  readonly test: EvalQuestion[];
  readonly duplicatesDropped: readonly string[];
  readonly unused: readonly string[];
  /** Missing questions per set and category (empty when all targets are met). */
  readonly shortfalls: readonly { readonly set: SetName; readonly category: Category; readonly missing: number }[];
}

/** Documents a question draws from (via its source chunks). */
function docsOf(candidate: Candidate, index: ChunkIndex): string[] {
  return [...new Set(candidate.source_chunk_ids.map((id) => index.byId.get(id)?.doc_path).filter((d): d is string => !!d))];
}

/**
 * Deterministic stratified split:
 * 1. drop near-duplicates (Jaccard >= duplicateThreshold);
 * 2. group questions that share a source chunk or are similar (>= nearThreshold) so a
 *    group never straddles dev and test;
 * 3. walk the groups in seeded order, filling dev then test per category quota,
 *    never letting a document exceed the per-set cap.
 */
export function buildSets(candidates: readonly Candidate[], index: ChunkIndex, options: BuildOptions = DEFAULT_BUILD_OPTIONS): BuildResult {
  const random = mulberry32(options.seed);
  const ordered = shuffled([...candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId)), random);
  const tokens = new Map(ordered.map((c) => [c.candidateId, questionTokens(c.question)]));
  const tok = (c: Candidate): Set<string> => tokens.get(c.candidateId) ?? new Set<string>();

  // 1. Duplicates.
  const kept: Candidate[] = [];
  const duplicatesDropped: string[] = [];
  for (const c of ordered) {
    if (kept.some((k) => jaccard(tok(k), tok(c)) >= options.duplicateThreshold)) duplicatesDropped.push(c.candidateId);
    else kept.push(c);
  }

  // 2. Union-find groups.
  const parent = kept.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    parent[i] = r;
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i];
      const b = kept[j];
      if (!a || !b) continue;
      // Same evidence + same task => likely paraphrases. An answer question and a handoff
      // question about the same chunk are different tasks and may go to different sets.
      const shareChunk =
        a.expected_behavior === b.expected_behavior && a.source_chunk_ids.some((id) => b.source_chunk_ids.includes(id));
      if (shareChunk || jaccard(tok(a), tok(b)) >= options.nearThreshold) union(i, j);
    }
  }
  const groups = new Map<number, Candidate[]>();
  kept.forEach((c, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), c]);
  });
  const groupList = [...groups.values()];

  // 3. Fill dev, then test.
  const assigned = new Set<Candidate[]>();
  const result: Record<SetName, Candidate[]> = { dev: [], test: [] };
  for (const set of ['dev', 'test'] as const) {
    const quota: Partial<Record<Category, number>> = { ...options.targets[set] };
    const docCount = new Map<string, number>();
    for (const group of groupList) {
      if (assigned.has(group)) continue;
      const need = new Map<Category, number>();
      for (const c of group) need.set(c.category, (need.get(c.category) ?? 0) + 1);
      const fitsQuota = [...need].every(([cat, n]) => (quota[cat] ?? 0) >= n);
      if (!fitsQuota) continue;
      const docNeed = new Map<string, number>();
      for (const c of group) for (const d of docsOf(c, index)) docNeed.set(d, (docNeed.get(d) ?? 0) + 1);
      const fitsDocs = [...docNeed].every(([d, n]) => (docCount.get(d) ?? 0) + n <= options.docCap[set]);
      if (!fitsDocs) continue;
      for (const [cat, n] of need) quota[cat] = (quota[cat] ?? 0) - n;
      for (const [d, n] of docNeed) docCount.set(d, (docCount.get(d) ?? 0) + n);
      result[set].push(...group);
      assigned.add(group);
    }
  }

  const shortfalls: { set: SetName; category: Category; missing: number }[] = [];
  for (const set of ['dev', 'test'] as const) {
    for (const category of ALL_CATEGORIES) {
      const target = options.targets[set][category] ?? 0;
      const got = result[set].filter((c) => c.category === category).length;
      if (got < target) shortfalls.push({ set, category, missing: target - got });
    }
  }

  const unused = groupList.filter((g) => !assigned.has(g)).flat().map((c) => c.candidateId);
  const finalize = (set: SetName): EvalQuestion[] =>
    shuffled(result[set], random).map((c, i) => toQuestion(`${set}-${String(i + 1).padStart(3, '0')}`, c));
  return { dev: finalize('dev'), test: finalize('test'), duplicatesDropped, unused, shortfalls };
}

/** Max share of a set coming from a single document (for the 5% rule). */
export function maxDocShare(questions: readonly EvalQuestion[], index: ChunkIndex): { doc: string | null; count: number; share: number } {
  const counts = new Map<string, number>();
  for (const q of questions) {
    const docs = new Set(q.source_chunk_ids.map((id) => index.byId.get(id)?.doc_path).filter((d): d is string => !!d));
    for (const d of docs) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let doc: string | null = null;
  let count = 0;
  for (const [d, n] of counts) if (n > count) [doc, count] = [d, n];
  return { doc, count, share: questions.length === 0 ? 0 : count / questions.length };
}

/** Largest Jaccard similarity between any dev and any test question. */
export function maxCrossSimilarity(dev: readonly EvalQuestion[], test: readonly EvalQuestion[]): number {
  let max = 0;
  const testTokens = test.map((q) => questionTokens(q.question));
  for (const d of dev) {
    const dt = questionTokens(d.question);
    for (const t of testTokens) max = Math.max(max, jaccard(dt, t));
  }
  return max;
}
