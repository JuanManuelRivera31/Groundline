import { sha256Hex } from '../hash.ts';
import type { EmbeddingTaskType } from './types.ts';

export interface CacheKeyInput {
  readonly model: string;
  readonly dimensions: number;
  readonly taskType: EmbeddingTaskType;
  readonly text: string;
  /**
   * The `title` API parameter is never sent today (the heading path is already
   * part of the text). If it ever is, it must be part of the key.
   */
  readonly title?: string | undefined;
}

/**
 * sha256 over every input that changes the resulting vector. A JSON array is
 * used as the encoding so field boundaries are unambiguous.
 */
export function embeddingCacheKey(input: CacheKeyInput): Promise<string> {
  return sha256Hex(JSON.stringify(['v1', input.model, input.dimensions, input.taskType, input.title ?? null, input.text]));
}
