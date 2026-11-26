import { answerResponseSchema, sourceMarkerResponseSchema, type MarkerStyle } from '../schema.ts';
import type { AnswerSource } from '../types.ts';
import { buildUserContentV1, PROMPT_VERSION, SYSTEM_INSTRUCTION_V1 } from './v1.ts';
import { buildUserContentV2, PROMPT_VERSION_V2, SYSTEM_INSTRUCTION_V2 } from './v2.ts';
import { buildUserContentV3, PROMPT_VERSION_V3, SYSTEM_INSTRUCTION_V3 } from './v3.ts';
import { buildUserContentV4, PROMPT_VERSION_V4, SYSTEM_INSTRUCTION_V4 } from './v4.ts';

export interface PromptSpec {
  readonly version: string;
  readonly system: string;
  buildUserContent(question: string, sources: readonly AnswerSource[]): string;
  /** numeric: [1] markers with citation.marker (v1). source: [S1] markers, citations without marker (v2). */
  readonly markerStyle: MarkerStyle;
  responseSchema(sourceIds: readonly string[]): Record<string, unknown>;
  /** Validate fenced code blocks as verbatim source excerpts (v3+). */
  readonly codeBlocks: boolean;
}

/** Versioned prompts. Recorded runs name the version they used. */
export const PROMPTS: Readonly<Record<string, PromptSpec>> = {
  [PROMPT_VERSION]: {
    version: PROMPT_VERSION,
    system: SYSTEM_INSTRUCTION_V1,
    buildUserContent: buildUserContentV1,
    markerStyle: 'numeric',
    responseSchema: answerResponseSchema,
    codeBlocks: false,
  },
  [PROMPT_VERSION_V2]: {
    version: PROMPT_VERSION_V2,
    system: SYSTEM_INSTRUCTION_V2,
    buildUserContent: buildUserContentV2,
    markerStyle: 'source',
    responseSchema: sourceMarkerResponseSchema,
    codeBlocks: false,
  },
  [PROMPT_VERSION_V3]: {
    version: PROMPT_VERSION_V3,
    system: SYSTEM_INSTRUCTION_V3,
    buildUserContent: buildUserContentV3,
    markerStyle: 'source',
    responseSchema: sourceMarkerResponseSchema,
    codeBlocks: true,
  },
  [PROMPT_VERSION_V4]: {
    version: PROMPT_VERSION_V4,
    system: SYSTEM_INSTRUCTION_V4,
    buildUserContent: buildUserContentV4,
    markerStyle: 'source',
    responseSchema: sourceMarkerResponseSchema,
    codeBlocks: true,
  },
};

export const DEFAULT_PROMPT_VERSION = PROMPT_VERSION_V4;

export function getPrompt(version: string): PromptSpec {
  const prompt = PROMPTS[version];
  if (!prompt) throw new Error(`Unknown prompt version "${version}". Known: ${Object.keys(PROMPTS).join(', ')}.`);
  return prompt;
}
