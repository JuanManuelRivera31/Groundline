import { GeminiApiError } from '../gemini/http.ts';

export interface GenerateRequest {
  /** System instruction (policy). */
  readonly system: string;
  /** Single user turn: delimited sources plus the customer message. */
  readonly user: string;
  /** JSON Schema the response must follow. */
  readonly responseSchema: unknown;
}

/** Real token counts from the API's usageMetadata. */
export interface GenerationUsage {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly thoughtsTokens: number;
  readonly totalTokens: number;
}

export interface GenerateResult {
  /** Concatenated non-thought text parts of the first candidate. */
  readonly text: string;
  /** e.g. STOP, MAX_TOKENS, SAFETY, or BLOCKED:<reason> when the prompt was blocked. */
  readonly finishReason: string;
  readonly usage: GenerationUsage;
  readonly observedHeaders: Readonly<Record<string, string>>;
}

/** One HTTP call that generates a response. No retries, no rate limiting. */
export interface GenerationClient {
  readonly model: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export class GenerationApiError extends GeminiApiError {
  override readonly name: string = 'GenerationApiError';
}
