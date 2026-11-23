import { describe, expect, it } from 'vitest';
import { ConfigError, generationLimitDefaults, parseConfig } from '../src/config.ts';
import { l2Normalize } from '../src/embeddings/normalize.ts';
import { backoffDelayMs } from '../src/embeddings/retry.ts';

describe('parseConfig', () => {
  it('applies conservative free-tier defaults and reports them', () => {
    const config = parseConfig({ GEMINI_API_KEY: 'k' });
    expect(config.embedding).toMatchObject({
      model: 'gemini-embedding-001',
      dimensions: 768,
      batchSize: 20,
      requestShape: 'top-level',
      limits: { rpm: 60, tpm: 20_000, rpd: 800 },
    });
    expect(config.defaultsUsed).toEqual(expect.arrayContaining(['GEMINI_EMBED_RPM', 'GEMINI_EMBED_TPM', 'GEMINI_EMBED_RPD']));
    expect(config.databaseUrl).toBe('postgres://groundline:groundline@127.0.0.1:54329/groundline');
  });

  it('treats empty strings as unset and reads overrides', () => {
    const config = parseConfig({ GEMINI_API_KEY: '', EMBEDDING_MODEL: 'gemini-embedding-2', EMBEDDING_DIMS: '1536', PG_PORT: '6000' });
    expect(config.geminiApiKey).toBeUndefined();
    expect(config.embedding.model).toBe('gemini-embedding-2');
    expect(config.embedding.dimensions).toBe(1536);
    expect(config.databaseUrl).toContain(':6000/');
  });

  it('defaults generation and answer settings and flags missing generation limits', () => {
    const config = parseConfig({});
    expect(config.generation).toEqual({
      model: 'gemini-3.5-flash-lite',
      temperature: 0,
      maxOutputTokens: 1024,
      thinkingLevel: 'MINIMAL',
      schemaField: 'responseJsonSchema',
      limits: { rpm: 10, tpm: 100_000, rpd: 200 },
    });
    expect(config.answer).toEqual({ candidates: 20, sources: 6, floor: 0.6, retrievalMode: 'vector' });
    expect(generationLimitDefaults(config)).toEqual(['GEN_RPM', 'GEN_TPM', 'GEN_RPD']);
    expect(generationLimitDefaults(parseConfig({ GEN_RPM: '5', GEN_TPM: '1000', GEN_RPD: '50' }))).toEqual([]);
  });

  it('validates generation and answer settings', () => {
    expect(parseConfig({ GEN_TEMPERATURE: '0.2', GEN_THINKING_LEVEL: 'off', ANSWER_FLOOR: '0.55' }).generation.thinkingLevel).toBeUndefined();
    expect(() => parseConfig({ GEN_TEMPERATURE: '0.5' })).toThrow(ConfigError);
    expect(() => parseConfig({ GEN_TEMPERATURE: '-1' })).toThrow(ConfigError);
    expect(() => parseConfig({ GEN_THINKING_LEVEL: 'max' })).toThrow(ConfigError);
    expect(() => parseConfig({ GEN_SCHEMA_FIELD: 'schema' })).toThrow(ConfigError);
    expect(() => parseConfig({ RETRIEVAL_MODE: 'fts' })).toThrow(ConfigError);
    expect(() => parseConfig({ ANSWER_SOURCES: '30', RETRIEVAL_CANDIDATES: '20' })).toThrow(ConfigError);
    expect(() => parseConfig({ ANSWER_FLOOR: '1.5' })).toThrow(ConfigError);
  });

  it('prefers an explicit DATABASE_URL', () => {
    expect(parseConfig({ DATABASE_URL: 'postgres://u:p@h:1/d' }).databaseUrl).toBe('postgres://u:p@h:1/d');
  });

  it('rejects invalid values', () => {
    expect(() => parseConfig({ EMBEDDING_DIMS: '3072' })).toThrow(ConfigError);
    expect(() => parseConfig({ GEMINI_EMBED_RPM: 'fast' })).toThrow(ConfigError);
    expect(() => parseConfig({ EMBEDDING_BATCH_SIZE: '50', GEMINI_EMBED_RPM: '10' })).toThrow(/cannot exceed/);
    expect(() => parseConfig({ GEMINI_EMBED_REQUEST_SHAPE: 'nested' })).toThrow(ConfigError);
  });
});

describe('l2Normalize', () => {
  it('produces a unit vector and rejects zero vectors', () => {
    expect(l2Normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(() => l2Normalize([0, 0])).toThrow();
  });
});

describe('backoffDelayMs', () => {
  const policy = { maxRetries: 5, baseDelayMs: 1_000, maxDelayMs: 8_000 };
  it('grows exponentially with jitter, capped, and never below retryAfter', () => {
    expect(backoffDelayMs(0, policy, () => 0)).toBe(500);
    expect(backoffDelayMs(2, policy, () => 1)).toBe(4_000);
    expect(backoffDelayMs(10, policy, () => 1)).toBe(8_000);
    expect(backoffDelayMs(0, policy, () => 0, 30_000)).toBe(30_000);
  });
});
