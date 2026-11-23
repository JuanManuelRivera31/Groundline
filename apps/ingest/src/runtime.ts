import { setTimeout as delay } from 'node:timers/promises';
import { GeminiEmbeddingClient, type AppConfig, type Clock, type EmbeddingClient, type Sleep } from '@groundline/core';

export const systemClock: Clock = { now: () => Date.now() };
export const systemSleep: Sleep = (ms) => delay(ms);

/** Real Gemini client, or undefined when GEMINI_API_KEY is not configured. */
export function createEmbeddingClient(config: AppConfig): EmbeddingClient | undefined {
  if (!config.geminiApiKey) return undefined;
  return new GeminiEmbeddingClient({
    apiKey: config.geminiApiKey,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
    maxBatchSize: config.embedding.batchSize,
    requestShape: config.embedding.requestShape,
    fetch: (url, init) => fetch(url, init),
  });
}

/** One-line, secret-free description of the effective configuration. */
export function describeConfig(config: AppConfig): string {
  const { model, dimensions, batchSize, limits } = config.embedding;
  return (
    `model ${model} | dims ${dimensions} | batch ${batchSize} | limits ${limits.rpm} RPM, ${limits.tpm} TPM, ${limits.rpd} RPD | ` +
    `GEMINI_API_KEY ${config.geminiApiKey ? 'set' : 'NOT set'}`
  );
}

export function defaultsNotice(config: AppConfig): string | undefined {
  const relevant = config.defaultsUsed.filter((name) => name.startsWith('GEMINI_EMBED_') || name.startsWith('EMBEDDING_'));
  return relevant.length > 0 ? `Using defaults for: ${relevant.join(', ')}` : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
