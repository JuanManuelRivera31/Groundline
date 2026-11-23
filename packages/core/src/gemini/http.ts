/** Shared HTTP plumbing for Gemini REST clients (embeddings and generation). */

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

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

const OBSERVED_HEADER = /rate|retry|quota/i;

/** Error from a Gemini HTTP call. Retries look only at `retryable` and `retryAfterMs`. */
export class GeminiApiError extends Error {
  override readonly name: string = 'GeminiApiError';
  /** HTTP status, or 0 for network failures. */
  readonly status: number;
  readonly retryable: boolean;
  /** Server-suggested delay (RetryInfo.retryDelay or Retry-After), if any. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: { status: number; retryable: boolean; retryAfterMs?: number | undefined; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface GeminiErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: { '@type'?: string; retryDelay?: string }[];
  };
}

export function parseDurationMs(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const protoDuration = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (protoDuration?.[1]) return Math.ceil(Number(protoDuration[1]) * 1000);
  const seconds = /^\d+$/.exec(value.trim());
  return seconds ? Number(value.trim()) * 1000 : undefined;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Rate-limit related response headers, for observability (never secrets). */
export function observedHeaders(response: FetchResponseLike): Record<string, string> {
  const observed: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (OBSERVED_HEADER.test(key)) observed[key.toLowerCase()] = value;
  });
  return observed;
}

/** Parses an error response into message parts plus retry hints. */
export function describeErrorResponse(
  response: FetchResponseLike,
  raw: string,
): { detail: string; statusText: string; retryable: boolean; retryAfterMs: number | undefined } {
  const body = safeJson(raw) as GeminiErrorBody | undefined;
  const retryInfo = body?.error?.details?.find((d) => d['@type']?.endsWith('google.rpc.RetryInfo'));
  const retryAfterMs = parseDurationMs(retryInfo?.retryDelay) ?? parseDurationMs(response.headers.get('retry-after'));
  return {
    detail: (body?.error?.message ?? raw.slice(0, 300)).slice(0, 500),
    statusText: body?.error?.status ? ` ${body.error.status}` : '',
    retryable: RETRYABLE_STATUS.has(response.status),
    retryAfterMs,
  };
}

/** Removes every occurrence of the API key from a message. */
export function redactKey(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join('[REDACTED]') : message;
}
