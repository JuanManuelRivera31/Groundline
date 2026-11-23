import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.ts';
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
