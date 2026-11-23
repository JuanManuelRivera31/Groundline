import { GeminiApiError } from '../gemini/http.ts';

/**
 * Gemini task types used for retrieval: documents are embedded with
 * RETRIEVAL_DOCUMENT and user questions with RETRIEVAL_QUERY
 * (https://aistudio.google.com/api-reference/embeddings).
 */
export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbedCallResult {
  /** One L2-normalized vector per input text, in input order. */
  readonly vectors: readonly (readonly number[])[];
  /** Rate-limit related response headers, for observability (never secrets). */
  readonly observedHeaders: Readonly<Record<string, string>>;
}

/** One HTTP call that embeds a batch of texts. No retries, no rate limiting. */
export interface EmbeddingClient {
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  embedBatch(texts: readonly string[], taskType: EmbeddingTaskType): Promise<EmbedCallResult>;
}

/** Error from the embeddings endpoint; see GeminiApiError for the retry fields. */
export class EmbeddingApiError extends GeminiApiError {
  override readonly name: string = 'EmbeddingApiError';
}
