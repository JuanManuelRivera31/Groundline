import type { EmbeddingRequestShape } from '../config.ts';
import { l2Normalize } from './normalize.ts';
import { EmbeddingApiError, type EmbedCallResult, type EmbeddingClient, type EmbeddingTaskType } from './types.ts';

/** Minimal fetch surface shared by Node, Workers and test fakes. */
export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null; forEach(callback: (value: string, key: string) => void): void };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

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

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const OBSERVED_HEADER = /rate|retry|quota/i;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

interface GeminiErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: { '@type'?: string; retryDelay?: string }[];
  };
}

interface BatchEmbedResponse {
  embeddings?: { values?: number[] }[];
}

function parseDurationMs(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const protoDuration = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (protoDuration?.[1]) return Math.ceil(Number(protoDuration[1]) * 1000);
  const seconds = /^\d+$/.exec(value.trim());
  return seconds ? Number(value.trim()) * 1000 : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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

  async embedBatch(texts: readonly string[], taskType: EmbeddingTaskType): Promise<EmbedCallResult> {
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
      });
    } catch (cause) {
      throw new EmbeddingApiError(this.#redact(`Gemini embeddings request failed: ${String(cause)}`), {
        status: 0,
        retryable: true,
        cause,
      });
    }

    const observedHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (OBSERVED_HEADER.test(key)) observedHeaders[key.toLowerCase()] = value;
    });

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
    const body = safeJson(raw) as GeminiErrorBody | undefined;
    const retryInfo = body?.error?.details?.find((d) => d['@type']?.endsWith('google.rpc.RetryInfo'));
    const retryAfterMs = parseDurationMs(retryInfo?.retryDelay) ?? parseDurationMs(response.headers.get('retry-after'));
    const detail = body?.error?.message ?? raw.slice(0, 300);
    let message = `Gemini embeddings request failed: HTTP ${response.status}${body?.error?.status ? ` ${body.error.status}` : ''}: ${detail.slice(0, 500)}`;
    if (response.status === 400 && /unknown name|cannot find field|invalid json payload/i.test(detail)) {
      const other: EmbeddingRequestShape = this.#shape === 'top-level' ? 'config' : 'top-level';
      message +=
        ` — the API rejected a request field while using GEMINI_EMBED_REQUEST_SHAPE=${this.#shape}. ` +
        `Set GEMINI_EMBED_REQUEST_SHAPE=${other} in .env and retry.`;
    }
    return new EmbeddingApiError(this.#redact(message), {
      status: response.status,
      retryable: RETRYABLE_STATUS.has(response.status),
      retryAfterMs,
    });
  }

  #redact(message: string): string {
    return message.split(this.#apiKey).join('[REDACTED]');
  }
}
