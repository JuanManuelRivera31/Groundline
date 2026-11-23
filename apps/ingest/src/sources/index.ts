import { plausible } from './plausible.ts';
import type { SourceDefinition } from './types.ts';

export type { SourceDefinition } from './types.ts';

const SOURCES: Readonly<Record<string, SourceDefinition>> = { [plausible.key]: plausible };

export function getSource(key: string): SourceDefinition {
  const source = SOURCES[key];
  if (!source) throw new Error(`Unknown source "${key}". Known sources: ${Object.keys(SOURCES).join(', ')}.`);
  return source;
}
