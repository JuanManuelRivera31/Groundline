import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { V2_EXAMPLE_QUESTIONS, V3_EXAMPLE_QUESTIONS } from '@groundline/core';
import { jaccard, questionTokens } from '../src/build.ts';
import { DEV_FILE } from '../src/io.ts';
import { parseJsonl, type EvalQuestion } from '../src/schema.ts';

// Prompt examples must be invented: none may resemble a dev question (test.jsonl is never read).
describe('prompt examples vs dev', () => {
  const dev = parseJsonl(readFileSync(DEV_FILE, 'utf8')) as EvalQuestion[];

  it.each([...V2_EXAMPLE_QUESTIONS, ...V3_EXAMPLE_QUESTIONS])('"%s" has token Jaccard < 0.6 with every dev question', (example) => {
    const tokens = questionTokens(example);
    const max = Math.max(...dev.map((q) => jaccard(tokens, questionTokens(q.question))));
    expect(max).toBeLessThan(0.6);
  });
});
