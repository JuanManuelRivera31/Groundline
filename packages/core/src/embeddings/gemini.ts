import type { EmbeddingRequestShape } from '../config.ts';
import {
  describeErrorResponse,
  GEMINI_API_BASE_URL,
  isAbortError,
  observedHeaders as readObservedHeaders,
  redactKey,
  safeJson,
  type FetchLike,
  type FetchResponseLike,
} from '../gemini/http.ts';
import { l2Normalize } from './normalize.ts';
import { EmbeddingApiError, type EmbedCallResult, type EmbeddingClient, type EmbeddingTaskType } from './types.ts';

export { GEMINI_API_BASE_URL, type FetchLike, type FetchResponseLike } from '../gemini/http.ts';

export interface GeminiEmbeddingClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  readonly fetch: FetchLike;
  /**
   * Where taskType/outputDimensionality go in each request. The REST examples
   * for gemini-embedding-001 put them next to `content` ("top-level"); the API
   * reference documents them inside `embedContentConfig` ("config").
   */
  readonly requestShape?: EmbeddingRequestShape | undefined;
  readonly baseUrl?: string | undefined;
}

interface BatchEmbedResponse {
  embeddings?: { values?: number[] }[];
}

/**
 * Gemini embeddings over REST `models/{model}:batchEmbedContents`.
 * The API key travels only in the `x-goog-api-key` header, never in the URL,
 * and is redacted from any error message.
 */
export class GeminiEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #shape: EmbeddingRequestShape;
  readonly #baseUrl: string;

  constructor(options: GeminiEmbeddingClientOptions) {
    if (!options.apiKey) throw new Error('GEMINI_API_KEY is missing.');
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.maxBatchSize = options.maxBatchSize;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#shape = options.requestShape ?? 'top-level';
    this.#baseUrl = (options.baseUrl ?? GEMINI_API_BASE_URL).replace(/\/+$/, '');
  }

  buildRequestBody(texts: readonly string[], taskType: EmbeddingTaskType): unknown {
    const modelName = `models/${this.model}`;
    return {
      requests: texts.map((text) => {
        const options = { taskType, outputDimensionality: this.dimensions };
        const content = { parts: [{ text }] };
        return this.#shape === 'config'
          ? { model: modelName, content, embedContentConfig: options }
          : { model: modelName, content, ...options };
      }),
    };
  }

  async embedBatch(
    texts: readonly string[],
    taskType: EmbeddingTaskType,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<EmbedCallResult> {
    if (texts.length === 0) return { vectors: [], observedHeaders: {} };
    if (texts.length > this.maxBatchSize) {
      throw new Error(`Batch of ${texts.length} texts exceeds maxBatchSize ${this.maxBatchSize}.`);
    }

    const url = `${this.#baseUrl}/models/${encodeURIComponent(this.model)}:batchEmbedContents`;
    let response: FetchResponseLike;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#apiKey },
        body: JSON.stringify(this.buildRequestBody(texts, taskType)),
        signal: options.signal,
      });
    } catch (cause) {
      if (isAbortError(cause)) {
        throw new EmbeddingApiError('Gemini embeddings request timed out (live budget).', { status: 0, retryable: true, cause, timeout: true });
      }
      throw new EmbeddingApiError(this.#redact(`Gemini embeddings request failed: ${String(cause)}`), {
        status: 0,
        retryable: true,
        cause,
      });
    }

    const observedHeaders = readObservedHeaders(response);

    const raw = await response.text();
    if (!response.ok) throw this.#toError(response, raw);

    const body = safeJson(raw) as BatchEmbedResponse | undefined;
    const embeddings = body?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new EmbeddingApiError(
        `Gemini returned ${Array.isArray(embeddings) ? embeddings.length : 'no'} embeddings for ${texts.length} texts.`,
        { status: response.status, retryable: false },
      );
    }

    const vectors = embeddings.map((embedding, i) => {
      const values = embedding.values;
      if (!Array.isArray(values) || values.length !== this.dimensions) {
        throw new EmbeddingApiError(
          `Embedding ${i} has ${Array.isArray(values) ? values.length : 0} dimensions, expected ${this.dimensions}. ` +
            'If outputDimensionality was ignored, try GEMINI_EMBED_REQUEST_SHAPE=config.',
          { status: response.status, retryable: false },
        );
      }
      return l2Normalize(values);
    });

    return { vectors, observedHeaders };
  }

  #toError(response: FetchResponseLike, raw: string): EmbeddingApiError {
    const { detail, statusText, retryable, retryAfterMs } = describeErrorResponse(response, raw);
    let message = `Gemini embeddings request failed: HTTP ${response.status}${statusText}: ${detail}`;
    if (response.status === 400 && /unknown name|cannot find field|invalid json payload/i.test(detail)) {
      const other: EmbeddingRequestShape = this.#shape === 'top-level' ? 'config' : 'top-level';
      message +=
        ` — the API rejected a request field while using GEMINI_EMBED_REQUEST_SHAPE=${this.#shape}. ` +
        `Set GEMINI_EMBED_REQUEST_SHAPE=${other} in .env and retry.`;
    }
    return new EmbeddingApiError(this.#redact(message), { status: response.status, retryable, retryAfterMs });
  }

  #redact(message: string): string {
    return redactKey(message, this.#apiKey);
  }
}
