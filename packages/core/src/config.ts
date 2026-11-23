export type EnvRecord = Readonly<Record<string, string | undefined>>;

export type EmbeddingRequestShape = 'top-level' | 'config';

export interface RateLimits {
  /** Requests per minute. */
  readonly rpm: number;
  /** Tokens per minute (estimated). */
  readonly tpm: number;
  /** Requests per day, reset at midnight Pacific time. */
  readonly rpd: number;
}

export interface EmbeddingConfig {
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize: number;
  readonly maxRetries: number;
  readonly requestShape: EmbeddingRequestShape;
  readonly limits: RateLimits;
}

export type GenerationSchemaFieldSetting = 'responseJsonSchema' | 'responseSchema';
export type RetrievalModeSetting = 'vector' | 'hybrid';

export interface GenerationConfig {
  readonly model: string;
  /** 0–0.2: answers must be deterministic and grounded. */
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** thinkingConfig.thinkingLevel, or undefined to omit it ("OFF"). */
  readonly thinkingLevel: string | undefined;
  readonly schemaField: GenerationSchemaFieldSetting;
  readonly limits: RateLimits;
}

export interface AnswerConfig {
  /** Retrieval candidates fetched before grouping by URL. */
  readonly candidates: number;
  /** Sources (URL groups) sent to the model. */
  readonly sources: number;
  /** Hard floor on max similarity: below it, "insufficient" without calling the model. */
  readonly floor: number;
  readonly retrievalMode: RetrievalModeSetting;
}

export interface AppConfig {
  /** Never print or log this value. */
  readonly geminiApiKey: string | undefined;
  readonly embedding: EmbeddingConfig;
  readonly generation: GenerationConfig;
  readonly answer: AnswerConfig;
  readonly databaseUrl: string;
  /** Names of settings that fell back to a default (for the startup notice). */
  readonly defaultsUsed: readonly string[];
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Defaults chosen to stay comfortably inside the Gemini free tier. */
export const DEFAULTS = {
  EMBEDDING_MODEL: 'gemini-embedding-001',
  EMBEDDING_DIMS: 768,
  EMBEDDING_BATCH_SIZE: 20,
  GEMINI_EMBED_RPM: 60,
  GEMINI_EMBED_TPM: 20_000,
  GEMINI_EMBED_RPD: 800,
  GEMINI_MAX_RETRIES: 6,
  GEMINI_EMBED_REQUEST_SHAPE: 'top-level',
  GEN_MODEL: 'gemini-3.5-flash-lite',
  GEN_TEMPERATURE: '0',
  GEN_MAX_OUTPUT_TOKENS: 1024,
  GEN_THINKING_LEVEL: 'MINIMAL',
  GEN_SCHEMA_FIELD: 'responseJsonSchema',
  GEN_RPM: 10,
  GEN_TPM: 100_000,
  GEN_RPD: 200,
  RETRIEVAL_MODE: 'vector',
  RETRIEVAL_CANDIDATES: 20,
  ANSWER_SOURCES: 6,
  /** Calibrated on dev v2 (ADR-0009). */
  ANSWER_FLOOR: '0.600',
  PG_PORT: 54329,
  POSTGRES_USER: 'groundline',
  POSTGRES_PASSWORD: 'groundline',
  POSTGRES_DB: 'groundline',
} as const;

/** HNSW indexes on pgvector `vector` columns support up to 2,000 dimensions. */
export const MAX_INDEXED_DIMENSIONS = 2000;

/**
 * Parses configuration from an env-like record (process.env on Node, the env
 * bindings object on Workers). Empty strings count as unset.
 */
export function parseConfig(env: EnvRecord): AppConfig {
  const defaultsUsed: string[] = [];

  const str = (name: keyof typeof DEFAULTS): string => {
    const raw = env[name]?.trim();
    if (raw) return raw;
    defaultsUsed.push(name);
    return String(DEFAULTS[name]);
  };

  const int = (name: keyof typeof DEFAULTS, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) {
      defaultsUsed.push(name);
      return Number(DEFAULTS[name]);
    }
    if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
    const value = Number(raw);
    if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}.`);
    return value;
  };

  const requestShape = str('GEMINI_EMBED_REQUEST_SHAPE');
  if (requestShape !== 'top-level' && requestShape !== 'config') {
    throw new ConfigError(`GEMINI_EMBED_REQUEST_SHAPE must be "top-level" or "config", got "${requestShape}".`);
  }

  const embedding: EmbeddingConfig = {
    model: str('EMBEDDING_MODEL'),
    dimensions: int('EMBEDDING_DIMS', 1, MAX_INDEXED_DIMENSIONS),
    batchSize: int('EMBEDDING_BATCH_SIZE', 1, 100),
    maxRetries: int('GEMINI_MAX_RETRIES', 0, 20),
    requestShape,
    limits: {
      rpm: int('GEMINI_EMBED_RPM', 1, 1_000_000),
      tpm: int('GEMINI_EMBED_TPM', 1, 1_000_000_000),
      rpd: int('GEMINI_EMBED_RPD', 1, 1_000_000_000),
    },
  };

  if (embedding.batchSize > embedding.limits.rpm) {
    throw new ConfigError(
      `EMBEDDING_BATCH_SIZE (${embedding.batchSize}) cannot exceed GEMINI_EMBED_RPM (${embedding.limits.rpm}): ` +
        'each text in a batch counts as one request against the quota.',
    );
  }

  const decimal = (name: 'GEN_TEMPERATURE' | 'ANSWER_FLOOR', min: number, max: number): number => {
    const raw = str(name);
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new ConfigError(`${name} must be a decimal number, got "${raw}".`);
    const value = Number(raw);
    if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}.`);
    return value;
  };

  const schemaField = str('GEN_SCHEMA_FIELD');
  if (schemaField !== 'responseJsonSchema' && schemaField !== 'responseSchema') {
    throw new ConfigError(`GEN_SCHEMA_FIELD must be "responseJsonSchema" or "responseSchema", got "${schemaField}".`);
  }
  const thinking = str('GEN_THINKING_LEVEL').toUpperCase();
  if (!['OFF', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(thinking)) {
    throw new ConfigError(`GEN_THINKING_LEVEL must be OFF, MINIMAL, LOW, MEDIUM or HIGH, got "${thinking}".`);
  }
  const generation: GenerationConfig = {
    model: str('GEN_MODEL'),
    temperature: decimal('GEN_TEMPERATURE', 0, 0.2),
    maxOutputTokens: int('GEN_MAX_OUTPUT_TOKENS', 64, 8192),
    thinkingLevel: thinking === 'OFF' ? undefined : thinking,
    schemaField,
    limits: {
      rpm: int('GEN_RPM', 1, 1_000_000),
      tpm: int('GEN_TPM', 1, 1_000_000_000),
      rpd: int('GEN_RPD', 1, 1_000_000_000),
    },
  };

  const retrievalMode = str('RETRIEVAL_MODE');
  if (retrievalMode !== 'vector' && retrievalMode !== 'hybrid') {
    throw new ConfigError(`RETRIEVAL_MODE must be "vector" or "hybrid", got "${retrievalMode}".`);
  }
  const answer: AnswerConfig = {
    candidates: int('RETRIEVAL_CANDIDATES', 1, 200),
    sources: int('ANSWER_SOURCES', 1, 20),
    floor: decimal('ANSWER_FLOOR', 0, 1),
    retrievalMode,
  };
  if (answer.sources > answer.candidates) {
    throw new ConfigError(`ANSWER_SOURCES (${answer.sources}) cannot exceed RETRIEVAL_CANDIDATES (${answer.candidates}).`);
  }

  const explicitUrl = env.DATABASE_URL?.trim();
  let databaseUrl: string;
  if (explicitUrl) {
    databaseUrl = explicitUrl;
  } else {
    const port = int('PG_PORT', 1, 65535);
    const user = encodeURIComponent(str('POSTGRES_USER'));
    const password = encodeURIComponent(str('POSTGRES_PASSWORD'));
    const db = encodeURIComponent(str('POSTGRES_DB'));
    databaseUrl = `postgres://${user}:${password}@127.0.0.1:${port}/${db}`;
  }

  const apiKey = env.GEMINI_API_KEY?.trim();
  return {
    geminiApiKey: apiKey === '' ? undefined : apiKey,
    embedding,
    generation,
    answer,
    databaseUrl,
    defaultsUsed,
  };
}

/** Generation rate-limit settings that fell back to defaults (the CLI warns about them). */
export function generationLimitDefaults(config: AppConfig): string[] {
  return config.defaultsUsed.filter((name) => name === 'GEN_RPM' || name === 'GEN_TPM' || name === 'GEN_RPD');
}
