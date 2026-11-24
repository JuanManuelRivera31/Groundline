import type { AnswerSource } from '../types.ts';
import { buildUserContentV1, PROMPT_VERSION, SYSTEM_INSTRUCTION_V1 } from './v1.ts';
import { buildUserContentV2, PROMPT_VERSION_V2, SYSTEM_INSTRUCTION_V2 } from './v2.ts';

export interface PromptSpec {
  readonly version: string;
  readonly system: string;
  buildUserContent(question: string, sources: readonly AnswerSource[]): string;
}

/** Versioned prompts. Recorded runs name the version they used. */
export const PROMPTS: Readonly<Record<string, PromptSpec>> = {
  [PROMPT_VERSION]: { version: PROMPT_VERSION, system: SYSTEM_INSTRUCTION_V1, buildUserContent: buildUserContentV1 },
  [PROMPT_VERSION_V2]: { version: PROMPT_VERSION_V2, system: SYSTEM_INSTRUCTION_V2, buildUserContent: buildUserContentV2 },
};

export const DEFAULT_PROMPT_VERSION = PROMPT_VERSION_V2;

export function getPrompt(version: string): PromptSpec {
  const prompt = PROMPTS[version];
  if (!prompt) throw new Error(`Unknown prompt version "${version}". Known: ${Object.keys(PROMPTS).join(', ')}.`);
  return prompt;
}
