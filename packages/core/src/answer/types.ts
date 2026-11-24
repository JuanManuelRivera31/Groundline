/** Statuses the model may choose (the response schema enum). */
export const MODEL_STATUSES = ['answered', 'insufficient', 'handoff', 'declined'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** Final statuses: the model's, plus "unavailable", set only by code when generation (or the live query embedding) is unavailable. */
export const ANSWER_STATUSES = [...MODEL_STATUSES, 'unavailable'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export type AnswerMode = 'eval' | 'live';

/** Where the articles shown with an answer came from. */
export type RetrievalFallback = 'vector' | 'fts' | 'none';

/** One generation attempt (HTTP call or a locally skipped model). */
export interface GenerationAttempt {
  readonly model: string;
  /** HTTP status; 0 for network/timeout; null when skipped locally (quota or rate window). */
  readonly status: number | null;
  readonly outcome: 'ok' | 'http_error' | 'timeout' | 'network' | 'quota_local' | 'rate_local' | 'budget';
  readonly ms: number;
}

export interface ArticleLink {
  readonly title: string;
  readonly url: string;
}

/** A retrieved chunk as the answer engine sees it (vector or hybrid). */
export interface RetrievedChunk {
  readonly chunkId: number;
  readonly ord: number;
  readonly url: string;
  readonly headingPath: string;
  readonly documentTitle: string;
  readonly content: string;
  /** Cosine similarity to the query; null if unknown. */
  readonly cosine: number | null;
}

/** One numbered source sent to the model: all retrieved chunks that share a URL. */
export interface AnswerSource {
  /** "S1" … "SN", in retrieval order. */
  readonly id: string;
  readonly title: string;
  readonly headingPath: string;
  readonly url: string;
  /** Chunk texts joined in document order (ord). */
  readonly text: string;
  /** Best cosine among the grouped chunks. */
  readonly similarity: number | null;
  readonly chunkIds: readonly number[];
}

/** Citation exactly as the model returned it. */
export interface ModelCitation {
  readonly marker: number;
  readonly source_id: string;
  readonly quote: string;
}

/** The model's structured output (validated shape, unvalidated content). */
export interface ModelAnswer {
  readonly status: ModelStatus;
  readonly declined_injection: boolean;
  readonly answer: string;
  readonly citations: readonly ModelCitation[];
  /** Empty string when not applicable. */
  readonly handoff_reason: string;
}

export interface VerifiedCitation {
  /** Renumbered marker as it appears in the final answer. */
  readonly marker: number;
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly headingPath: string;
  readonly quote: string;
}

export type InvalidCitationReason = 'unknown_source' | 'quote_not_found' | 'quote_too_long' | 'quote_too_short' | 'empty_quote';

export interface InvalidCitation extends ModelCitation {
  readonly reason: InvalidCitationReason;
}

export type RemovalReason = 'failed_citation' | 'unmarked_claim';

export interface RemovedSentence {
  readonly text: string;
  readonly reason: RemovalReason;
}

export interface AnswerUsage {
  readonly generationRequests: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtsTokens: number;
  /** Estimated tokens of the query embedding. */
  readonly embeddingTokens: number;
}

export interface AnswerLatency {
  readonly retrievalMs: number;
  readonly generationMs: number;
  /** retrieval + generation + validation; excludes limiter queue wait. */
  readonly totalMs: number;
  readonly queueWaitMs: number;
}

export interface AnswerResult {
  readonly status: AnswerStatus;
  readonly declinedInjection: boolean;
  /** Final text shown to the customer, with renumbered [n] markers. */
  readonly answer: string;
  readonly citations: readonly VerifiedCitation[];
  readonly handoffOffered: boolean;
  readonly handoffReason: string;
  readonly sources: readonly AnswerSource[];
  readonly maxSimilarity: number;
  readonly floorHit: boolean;
  /** Status the model chose before code validation (null if the model was not called). */
  readonly modelStatus: ModelStatus | null;
  readonly mode: AnswerMode;
  /** Model that produced the validated answer (null if none did). */
  readonly answeredBy: string | null;
  /** Model switches in the chain (live mode); 0 in eval mode. */
  readonly hops: number;
  readonly attempts: readonly GenerationAttempt[];
  /** "vector" normally; "fts"/"none" when the live query embedding failed. */
  readonly retrievalFallback: RetrievalFallback;
  /** Articles shown with an "unavailable" answer (up to 3 distinct documents). */
  readonly articles: readonly ArticleLink[];
  /** Citations returned by the model, before validation. */
  readonly modelCitations: readonly ModelCitation[];
  readonly invalidCitations: readonly InvalidCitation[];
  readonly removedSentences: readonly RemovedSentence[];
  /** e.g. "invalid_output: ..." or "no_valid_citations"; null when all went well. */
  readonly error: string | null;
  readonly finishReason: string | null;
  readonly promptVersion: string;
  readonly usage: AnswerUsage;
  readonly latency: AnswerLatency;
  /** Equivalent cost at paid list price (the free tier costs $0); null if unpriced. */
  readonly costUsd: number | null;
}
