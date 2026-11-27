import type { EnvRecord } from '@groundline/core';
import { DEFAULT_BLOCKED_COUNTRIES } from './region.ts';

export type ApiRuntime = 'node' | 'workers';
export type WebhookFormat = 'json' | 'slack';

export interface HandoffWebhookConfig {
  readonly url: string;
  readonly format: WebhookFormat;
  /** HMAC-SHA256 key for X-Groundline-Signature; never logged. */
  readonly secret: string | null;
  readonly timeoutMs: number;
}

/** Demo API settings (ADR-0012). The engine keeps its own AppConfig from @groundline/core. */
export interface ApiConfig {
  readonly runtime: ApiRuntime;
  /** Exact origins allowed by CORS (e.g. "https://demo.example.com"). */
  readonly corsOrigins: readonly string[];
  /** Bearer token for /v1/admin/*; null disables the admin API (404). Never logged. */
  readonly adminToken: string | null;
  /** Key for the daily IP-hash salt. Never logged. */
  readonly ipHashSecret: string;
  /** True when no IP_HASH_SECRET was set and a per-process random one is used (Node only). */
  readonly ipHashSecretGenerated: boolean;
  /** Generation requests per chain model per Pacific day before articles-only mode. */
  readonly demoDailyGenCap: number;
  readonly rateLimitPerMinute: number;
  readonly rateLimitPerDay: number;
  readonly maxQuestionChars: number;
  readonly maxNoteChars: number;
  readonly blockedCountries: ReadonlySet<string>;
  /** Block when the country is unknown (Workers); Node allows it, since local requests carry none. */
  readonly blockUnknownCountry: boolean;
  /** Node only: country assumed for every local request. */
  readonly devCountry: string | null;
  /** Node only: honour the x-groundline-dev-country header (manual tests). */
  readonly devCountryHeader: boolean;
  readonly retentionDays: number;
  readonly handoffWebhook: HandoffWebhookConfig | null;
  readonly port: number;
}

export class ApiConfigError extends Error {
  override readonly name = 'ApiConfigError';
}

const MIN_ADMIN_TOKEN_CHARS = 32;
const MIN_IP_SECRET_CHARS = 32;

function intSetting(env: EnvRecord, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ApiConfigError(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function boolSetting(env: EnvRecord, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function countrySetting(env: EnvRecord, name: string): string | null {
  const raw = env[name]?.trim().toUpperCase();
  if (!raw) return null;
  if (!/^[A-Z]{2}$/.test(raw)) throw new ApiConfigError(`${name} must be a two-letter country code.`);
  return raw;
}

function emptyToNull(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value === undefined || value === '' ? null : value;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function webhookSetting(env: EnvRecord): HandoffWebhookConfig | null {
  const raw = env.HANDOFF_WEBHOOK_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiConfigError('HANDOFF_WEBHOOK_URL is not a valid URL.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new ApiConfigError('HANDOFF_WEBHOOK_URL must use https (http only for localhost).');
  const rawFormat = env.HANDOFF_WEBHOOK_FORMAT?.trim().toLowerCase();
  const format = rawFormat === undefined || rawFormat === '' ? 'json' : rawFormat;
  if (format !== 'json' && format !== 'slack') throw new ApiConfigError('HANDOFF_WEBHOOK_FORMAT must be "json" or "slack".');
  return {
    url: url.toString(),
    format,
    secret: emptyToNull(env.HANDOFF_WEBHOOK_SECRET),
    timeoutMs: intSetting(env, 'HANDOFF_WEBHOOK_TIMEOUT_MS', 5_000, 100, 30_000),
  };
}

export function parseApiConfig(env: EnvRecord, runtime: ApiRuntime): ApiConfig {
  const adminToken = emptyToNull(env.ADMIN_TOKEN);
  if (adminToken !== null && adminToken.length < MIN_ADMIN_TOKEN_CHARS) throw new ApiConfigError(`ADMIN_TOKEN must have at least ${MIN_ADMIN_TOKEN_CHARS} characters.`);

  let ipHashSecret = env.IP_HASH_SECRET?.trim() ?? '';
  let ipHashSecretGenerated = false;
  if (ipHashSecret === '') {
    // Workers isolates do not share memory: a random key per isolate would break the per-IP counts.
    if (runtime === 'workers') throw new ApiConfigError('IP_HASH_SECRET is required on Workers (wrangler secret put IP_HASH_SECRET).');
    ipHashSecret = randomSecret();
    ipHashSecretGenerated = true;
  } else if (ipHashSecret.length < MIN_IP_SECRET_CHARS) {
    throw new ApiConfigError(`IP_HASH_SECRET must have at least ${MIN_IP_SECRET_CHARS} characters.`);
  }

  const blockedRaw = env.BLOCKED_COUNTRIES?.trim();
  const blockedCountries = blockedRaw
    ? new Set(
        blockedRaw
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter((c) => c.length > 0),
      )
    : new Set(DEFAULT_BLOCKED_COUNTRIES);
  for (const c of blockedCountries) if (!/^[A-Z]{2}$/.test(c)) throw new ApiConfigError(`BLOCKED_COUNTRIES has an invalid code: ${c}`);

  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
  for (const o of corsOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(o)) throw new ApiConfigError(`CORS_ORIGINS entries must be origins like https://example.com (got ${o}).`);
  }

  return {
    runtime,
    corsOrigins,
    adminToken,
    ipHashSecret,
    ipHashSecretGenerated,
    demoDailyGenCap: intSetting(env, 'DEMO_DAILY_GEN_CAP', 150, 0, 100_000),
    rateLimitPerMinute: intSetting(env, 'RATE_LIMIT_PER_MINUTE', 3, 1, 1_000),
    rateLimitPerDay: intSetting(env, 'RATE_LIMIT_PER_DAY', 15, 1, 100_000),
    maxQuestionChars: intSetting(env, 'MAX_QUESTION_CHARS', 500, 1, 10_000),
    maxNoteChars: 500,
    blockedCountries,
    blockUnknownCountry: runtime === 'workers',
    devCountry: runtime === 'node' ? countrySetting(env, 'DEV_COUNTRY') : null,
    devCountryHeader: runtime === 'node' && boolSetting(env, 'DEV_COUNTRY_HEADER'),
    retentionDays: intSetting(env, 'RETENTION_DAYS', 30, 1, 3_650),
    handoffWebhook: webhookSetting(env),
    port: intSetting(env, 'API_PORT', 8787, 1, 65_535),
  };
}
