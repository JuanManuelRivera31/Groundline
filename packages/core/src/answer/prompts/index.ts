import { answerResponseSchema, sourceMarkerResponseSchema, type MarkerStyle } from '../schema.ts';
import type { AnswerSource } from '../types.ts';
import { buildUserContentV1, PROMPT_VERSION, SYSTEM_INSTRUCTION_V1 } from './v1.ts';
import { buildUserContentV2, PROMPT_VERSION_V2, SYSTEM_INSTRUCTION_V2 } from './v2.ts';

export interface PromptSpec {
  readonly version: string;
  readonly system: string;
  buildUserContent(question: string, sources: readonly AnswerSource[]): string;
  /** numeric: [1] markers with citation.marker (v1). source: [S1] markers, citations without marker (v2). */
  readonly markerStyle: MarkerStyle;
  responseSchema(sourceIds: readonly string[]): Record<string, unknown>;
}

/** Versioned prompts. Recorded runs name the version they used. */
export const PROMPTS: Readonly<Record<string, PromptSpec>> = {
  [PROMPT_VERSION]: {
    version: PROMPT_VERSION,
    system: SYSTEM_INSTRUCTION_V1,
    buildUserContent: buildUserContentV1,
    markerStyle: 'numeric',
    responseSchema: answerResponseSchema,
  },
  [PROMPT_VERSION_V2]: {
    version: PROMPT_VERSION_V2,
    system: SYSTEM_INSTRUCTION_V2,
    buildUserContent: buildUserContentV2,
    markerStyle: 'source',
    responseSchema: sourceMarkerResponseSchema,
  },
};

export const DEFAULT_PROMPT_VERSION = PROMPT_VERSION_V2;

export function getPrompt(version: string): PromptSpec {
  const prompt = PROMPTS[version];
  if (!prompt) throw new Error(`Unknown prompt version "${version}". Known: ${Object.keys(PROMPTS).join(', ')}.`);
  return prompt;
}
