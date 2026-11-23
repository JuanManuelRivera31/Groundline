export const ANSWER_CATEGORIES = ['billing_account', 'install_integrations', 'dashboard_metrics', 'api'] as const;
export const UNANSWERABLE_CATEGORIES = ['not_covered', 'off_topic', 'competitor', 'account_action', 'prompt_injection'] as const;
export const ALL_CATEGORIES = [...ANSWER_CATEGORIES, ...UNANSWERABLE_CATEGORIES] as const;

export type AnswerCategory = (typeof ANSWER_CATEGORIES)[number];
export type UnanswerableCategory = (typeof UNANSWERABLE_CATEGORIES)[number];
export type Category = AnswerCategory | UnanswerableCategory;

/**
 * What a correct assistant does (graded per type in S3):
 * - answer: answer from the docs with citations;
 * - abstain: say it does not know and offer a human (not covered, off topic);
 * - handoff: cannot perform account actions; hand off and share applicable documented steps;
 * - decline: politely refuse and steer back (prompt injection, competitor comparisons).
 */
export type ExpectedBehavior = 'answer' | 'abstain' | 'handoff' | 'decline';
export const BEHAVIORS: readonly ExpectedBehavior[] = ['answer', 'abstain', 'handoff', 'decline'];

export const BEHAVIOR_BY_CATEGORY: Readonly<Record<Category, ExpectedBehavior>> = {
  billing_account: 'answer',
  install_integrations: 'answer',
  dashboard_metrics: 'answer',
  api: 'answer',
  not_covered: 'abstain',
  off_topic: 'abstain',
  competitor: 'decline',
  account_action: 'handoff',
  prompt_injection: 'decline',
};

export interface EvalQuestion {
  readonly id: string;
  readonly question: string;
  readonly answerable: boolean;
  readonly category: Category;
  readonly expected_behavior: ExpectedBehavior;
  /** Acceptable citation URLs (with anchor). Empty for abstain/decline; optional for handoff. */
  readonly expected_urls: readonly string[];
  readonly reference_answer: string;
  readonly key_facts: readonly string[];
  readonly unanswerable_reason: string;
  readonly source_chunk_ids: readonly string[];
}

export type QuestionDraft = Omit<EvalQuestion, 'id'>;

/** Field order used when writing sets. */
export const FIELD_ORDER: readonly (keyof EvalQuestion)[] = [
  'id',
  'question',
  'answerable',
  'category',
  'expected_behavior',
  'expected_urls',
  'reference_answer',
  'key_facts',
  'unanswerable_reason',
  'source_chunk_ids',
];

export interface ChunkRef {
  readonly id: string;
  readonly url: string;
  readonly doc_path: string;
}

export interface ChunkIndex {
  readonly byId: ReadonlyMap<string, ChunkRef>;
  readonly urls: ReadonlySet<string>;
}

export function chunkIndex(chunks: readonly ChunkRef[]): ChunkIndex {
  return { byId: new Map(chunks.map((c) => [c.id, c])), urls: new Set(chunks.map((c) => c.url)) };
}

const EMAIL = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g;
const ALLOWED_EMAIL_DOMAIN = /(^|\.)example\.(com|org|net)$|\.test$/i;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

export interface ValidateOptions {
  /** Public vendor domains whose documented addresses may appear (e.g. a support address quoted in the docs). */
  readonly vendorEmailDomains?: readonly string[];
}

/** Validates one question draft (with or without id). Returns a list of problems; empty means valid. */
export function validateQuestion(value: unknown, index: ChunkIndex, options: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object') return ['not an object'];
  const q = value as Record<string, unknown>;

  const question = q.question;
  if (typeof question !== 'string' || question.trim().length < 5) errors.push('question missing or too short');
  const category = q.category;
  if (typeof category !== 'string' || !(ALL_CATEGORIES as readonly string[]).includes(category)) {
    errors.push(`unknown category ${JSON.stringify(category)}`);
    return errors;
  }
  const behavior = BEHAVIOR_BY_CATEGORY[category as Category];
  if (q.expected_behavior !== behavior) errors.push(`expected_behavior must be "${behavior}" for ${category}`);
  if (q.answerable !== (behavior === 'answer')) errors.push(`answerable must be ${String(behavior === 'answer')} for ${category}`);

  const urls = q.expected_urls;
  const ids = q.source_chunk_ids;
  const facts = q.key_facts;
  const reference = q.reference_answer;
  const reason = q.unanswerable_reason;
  if (!isStringArray(urls)) errors.push('expected_urls must be a string array');
  if (!isStringArray(ids)) errors.push('source_chunk_ids must be a string array');
  if (!isStringArray(facts)) errors.push('key_facts must be a string array');
  if (typeof reference !== 'string' || reference.trim() === '') errors.push('reference_answer missing');
  if (typeof reason !== 'string') errors.push('unanswerable_reason must be a string');
  if (errors.length > 0) return errors;

  const urlList = urls as string[];
  const idList = ids as string[];
  const factList = facts as string[];
  const reasonText = reason as string;

  for (const url of urlList) if (!index.urls.has(url)) errors.push(`unknown expected_url ${url}`);
  for (const id of idList) if (!index.byId.has(id)) errors.push(`unknown source_chunk_id ${id}`);
  if (new Set(urlList).size !== urlList.length) errors.push('duplicate expected_urls');

  switch (behavior) {
    case 'answer':
      if (urlList.length === 0) errors.push('answer questions need expected_urls');
      if (idList.length === 0) errors.push('answer questions need source_chunk_ids');
      if (factList.length === 0) errors.push('answer questions need key_facts');
      if (reasonText !== '') errors.push('answer questions must have an empty unanswerable_reason');
      break;
    case 'handoff':
      if (reasonText.trim() === '') errors.push('unanswerable_reason missing');
      if (urlList.length > 0 && idList.length === 0) errors.push('handoff with expected_urls needs source_chunk_ids');
      break;
    case 'abstain':
    case 'decline':
      if (reasonText.trim() === '') errors.push('unanswerable_reason missing');
      if (urlList.length > 0 || idList.length > 0) errors.push(`${behavior} questions must not have expected_urls or source_chunk_ids`);
      break;
  }

  // Each source chunk's URL should be acceptable (it was the evidence).
  if (behavior === 'answer') {
    for (const id of idList) {
      const chunk = index.byId.get(id);
      if (chunk && !urlList.includes(chunk.url)) errors.push(`source chunk ${id} url not in expected_urls`);
    }
  }

  const text = [question, reference, ...factList].join(' ');
  for (const match of text.matchAll(EMAIL)) {
    const domain = (match[1] ?? '').toLowerCase();
    const vendor = (options.vendorEmailDomains ?? []).includes(domain);
    if (!vendor && !ALLOWED_EMAIL_DOMAIN.test(domain)) errors.push(`non-example email ${match[0]}`);
  }
  return errors;
}

/** Normalizes a draft into canonical field order with the given id. */
export function toQuestion(id: string, draft: QuestionDraft): EvalQuestion {
  return {
    id,
    question: draft.question.trim(),
    answerable: draft.answerable,
    category: draft.category,
    expected_behavior: draft.expected_behavior,
    expected_urls: [...draft.expected_urls],
    reference_answer: draft.reference_answer.trim(),
    key_facts: [...draft.key_facts],
    unanswerable_reason: draft.unanswerable_reason.trim(),
    source_chunk_ids: [...draft.source_chunk_ids],
  };
}

export function parseJsonl(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Invalid JSON on line ${i + 1}`);
      }
    });
}

export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}
