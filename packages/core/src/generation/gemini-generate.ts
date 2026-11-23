import {
  describeErrorResponse,
  GEMINI_API_BASE_URL,
  observedHeaders,
  redactKey,
  safeJson,
  type FetchLike,
  type FetchResponseLike,
} from '../gemini/http.ts';
import { GenerationApiError, type GenerateRequest, type GenerateResult, type GenerationClient } from './types.ts';

/** Where the JSON Schema goes in generationConfig. */
export type GenerationSchemaField = 'responseJsonSchema' | 'responseSchema';

export interface GeminiGenerationClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch: FetchLike;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** thinkingConfig.thinkingLevel (Gemini 3+), e.g. "MINIMAL". Omitted when undefined. */
  readonly thinkingLevel?: string | undefined;
  readonly schemaField?: GenerationSchemaField | undefined;
  readonly baseUrl?: string | undefined;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Gemini text generation over REST `models/{model}:generateContent` with a
 * JSON response schema. The API key travels only in the `x-goog-api-key`
 * header and is redacted from any error message.
 * Reference: https://ai.google.dev/api/generate-content
 */
export class GeminiGenerationClient implements GenerationClient {
  readonly model: string;
  readonly #options: GeminiGenerationClientOptions;
  readonly #schemaField: GenerationSchemaField;
  readonly #baseUrl: string;

  constructor(options: GeminiGenerationClientOptions) {
    if (!options.apiKey) throw new Error('GEMINI_API_KEY is missing.');
    this.model = options.model;
    this.#options = options;
    this.#schemaField = options.schemaField ?? 'responseJsonSchema';
    this.#baseUrl = (options.baseUrl ?? GEMINI_API_BASE_URL).replace(/\/+$/, '');
  }

  buildRequestBody(request: GenerateRequest): unknown {
    const { temperature, maxOutputTokens, thinkingLevel } = this.#options;
    return {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
        [this.#schemaField]: request.responseSchema,
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const url = `${this.#baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    let response: FetchResponseLike;
    try {
      response = await this.#options.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#options.apiKey },
        body: JSON.stringify(this.buildRequestBody(request)),
      });
    } catch (cause) {
      throw new GenerationApiError(this.#redact(`Gemini generate request failed: ${String(cause)}`), {
        status: 0,
        retryable: true,
        cause,
      });
    }

    const headers = observedHeaders(response);
    const raw = await response.text();
    if (!response.ok) throw this.#toError(response, raw);

    const body = safeJson(raw) as GenerateContentResponse | undefined;
    if (!body) throw new GenerationApiError('Gemini returned a non-JSON response.', { status: response.status, retryable: false });
    const candidate = body.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('');
    const blocked = body.promptFeedback?.blockReason;
    const meta = body.usageMetadata ?? {};
    const promptTokens = meta.promptTokenCount ?? 0;
    const outputTokens = meta.candidatesTokenCount ?? 0;
    const thoughtsTokens = meta.thoughtsTokenCount ?? 0;
    return {
      text,
      finishReason: blocked ? `BLOCKED:${blocked}` : (candidate?.finishReason ?? 'UNKNOWN'),
      usage: {
        promptTokens,
        outputTokens,
        thoughtsTokens,
        totalTokens: meta.totalTokenCount ?? promptTokens + outputTokens + thoughtsTokens,
      },
      observedHeaders: headers,
    };
  }

  #toError(response: FetchResponseLike, raw: string): GenerationApiError {
    const { detail, statusText, retryable, retryAfterMs } = describeErrorResponse(response, raw);
    let message = `Gemini generate request failed: HTTP ${response.status}${statusText}: ${detail}`;
    if (response.status === 400 && /unknown name|cannot find field|invalid json payload/i.test(detail)) {
      const other: GenerationSchemaField = this.#schemaField === 'responseJsonSchema' ? 'responseSchema' : 'responseJsonSchema';
      message +=
        ` — the API rejected a request field while using GEN_SCHEMA_FIELD=${this.#schemaField}. ` +
        `Try GEN_SCHEMA_FIELD=${other} in .env.`;
    }
    return new GenerationApiError(this.#redact(message), { status: response.status, retryable, retryAfterMs });
  }

  #redact(message: string): string {
    return redactKey(message, this.#options.apiKey);
  }
}
