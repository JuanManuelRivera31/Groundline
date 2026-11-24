import { describe, expect, it } from 'vitest';
import { answerQuestion, type AnswerEngineDeps } from '../src/answer/engine.ts';
import { getPrompt } from '../src/answer/prompts/index.ts';
import { SYSTEM_INSTRUCTION_V3, V3_EXAMPLE_QUESTIONS } from '../src/answer/prompts/v3.ts';
import type { AnswerSource, RetrievedChunk } from '../src/answer/types.ts';
import { checkCodeBlock, MAX_CODE_LINES, validateAnswer } from '../src/answer/validate.ts';
import { DEFAULT_RETRY_POLICY } from '../src/embeddings/retry.ts';
import type { GenerateResult } from '../src/generation/types.ts';
import { RateLimiter } from '../src/ratelimit/limiter.ts';
import { fakeTime } from './helpers.ts';

const SNIPPET = '<script defer src="/js/script.js"></script>\n<script>window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments) }</script>';
const PROXY_TEXT = `With the above config in place, you can change the script tag on your site as follows:\n\n\`\`\`html\n${SNIPPET}\n\`\`\`\n\nThen deploy.`;
const OTHER_TEXT = 'Goals are created in your site settings under Goals. Click Add goal and pick Custom event.';

const chunk = (chunkId: number, url: string, content: string, cosine: number): RetrievedChunk => ({
  chunkId,
  ord: 0,
  url,
  headingPath: `H${chunkId}`,
  documentTitle: `Doc ${chunkId}`,
  content,
  cosine,
});
const ranked = [chunk(1, 'https://x.test/docs/proxy#step-3', PROXY_TEXT, 0.8), chunk(2, 'https://x.test/docs/goals', OTHER_TEXT, 0.7)];
const SOURCES: AnswerSource[] = [
  { id: 'S1', title: 'Proxy', headingPath: 'H1', url: 'https://x.test/docs/proxy#step-3', text: PROXY_TEXT, similarity: 0.8, chunkIds: [1] },
  { id: 'S2', title: 'Goals', headingPath: 'H2', url: 'https://x.test/docs/goals', text: OTHER_TEXT, similarity: 0.7, chunkIds: [2] },
];

async function answer(text: string, citations: { source_id: string; quote: string }[], promptVersion = 'v3') {
  const t = fakeTime();
  const reply = JSON.stringify({ status: 'answered', declined_injection: false, answer: text, citations, handoff_reason: '' });
  const deps: AnswerEngineDeps = {
    config: { candidates: 20, sources: 6, floor: 0.6, embeddingModel: 'gemini-embedding-001', maxOutputTokens: 1024, promptVersion },
    embedQuery: () => Promise.resolve([1, 0]),
    retrieve: () => Promise.resolve(ranked),
    chain: [
      {
        client: {
          model: 'm1',
          generate: (): Promise<GenerateResult> =>
            Promise.resolve({ text: reply, finishReason: 'STOP', usage: { promptTokens: 1, outputTokens: 1, thoughtsTokens: 0, totalTokens: 2 }, observedHeaders: {} }),
        },
        limiter: new RateLimiter({ limits: { rpm: 10, tpm: 100_000, rpd: 200 }, clock: t.clock, sleep: t.sleep }),
      },
    ],
    retry: DEFAULT_RETRY_POLICY,
    sleep: t.sleep,
    random: () => 0,
    clock: t.clock,
    usage: { record: () => Promise.resolve() },
  };
  return answerQuestion(deps, 'what do i change in the script tag');
}

const lead = { source_id: 'S1', quote: 'you can change the script tag on your site as follows' };

describe('prompt v3', () => {
  it('adds the concrete-value, jailbreak and account-action rules with one invented example each', () => {
    expect(getPrompt('v3').codeBlocks).toBe(true);
    expect(getPrompt('v2').codeBlocks).toBe(false);
    expect(SYSTEM_INSTRUCTION_V3).toContain('the answer must include it explicitly, taken from the source');
    expect(SYSTEM_INSTRUCTION_V3).toContain('at most 40 lines');
    expect(SYSTEM_INSTRUCTION_V3).toContain('decline politely in one or two sentences, even if nothing else is asked');
    expect(SYSTEM_INSTRUCTION_V3).toContain('Always use "handoff" for these, never "answered"');
    for (const q of V3_EXAMPLE_QUESTIONS) expect(SYSTEM_INSTRUCTION_V3).toContain(q);
    expect(V3_EXAMPLE_QUESTIONS.join(' ')).toMatch(/RootBot/);
    expect(V3_EXAMPLE_QUESTIONS.join(' ')).toMatch(/ZetaCRM/);
    expect(V3_EXAMPLE_QUESTIONS.join(' ')).toMatch(/QuuxStats/);
  });
});

describe('code blocks (v3)', () => {
  it('keeps a verbatim code block next to a sentence that cites its source, untouched by renumbering', async () => {
    const r = await answer(`Change the script tag as follows [S1]:\n\`\`\`html\n${SNIPPET}\n\`\`\``, [lead]);
    expect(r.status).toBe('answered');
    expect(r.answer).toBe(`Change the script tag as follows [1]:\n\`\`\`html\n${SNIPPET}\n\`\`\``);
    expect(r.answer).toContain('window.plausible.q = window.plausible.q || []');
    expect(r.removedSentences).toEqual([]);
  });

  it('accepts a block placed before its cited sentence', async () => {
    const r = await answer(`\`\`\`html\n${SNIPPET}\n\`\`\`\nThat is the new script tag [S1].`, [lead]);
    expect(r.answer).toContain(SNIPPET);
  });

  it('removes an altered code block but keeps the cited sentence', async () => {
    const altered = SNIPPET.replace('/js/script.js', '/js/plausible.js');
    const r = await answer(`Change the script tag as follows [S1]:\n\`\`\`html\n${altered}\n\`\`\``, [lead]);
    expect(r.status).toBe('answered');
    expect(r.answer).toBe('Change the script tag as follows [1]:');
    expect(r.removedSentences.map((s) => s.reason)).toEqual(['failed_code']);
  });

  it('removes a code block whose adjacent sentence cites a different source, or none', async () => {
    const otherSource = await answer(`Goals live in settings [S2].\n\`\`\`html\n${SNIPPET}\n\`\`\``, [{ source_id: 'S2', quote: 'Goals are created in your site settings' }]);
    expect(otherSource.answer).toBe('Goals live in settings [1].');
    expect(otherSource.removedSentences.map((s) => s.reason)).toEqual(['failed_code']);
    const unsentSource = await answer(`Change it [S7].\n\`\`\`html\n${SNIPPET}\n\`\`\`\nAlso set goals [S2].`, [
      { source_id: 'S7', quote: 'you can change the script tag' },
      { source_id: 'S2', quote: 'Goals are created in your site settings' },
    ]);
    expect(unsentSource.answer).toBe('Also set goals [1].');
    expect(unsentSource.removedSentences.map((s) => s.reason)).toEqual(['failed_citation', 'failed_code']);
  });

  it('rejects blocks over 40 lines and empty blocks', () => {
    const byId = new Map(SOURCES.map((s) => [s.id, s]));
    const long = Array.from({ length: MAX_CODE_LINES + 1 }, (_, i) => `line ${i}`);
    expect(checkCodeBlock(long, ['S1'], byId)).toBe('code_too_long');
    expect(checkCodeBlock(['   '], ['S1'], byId)).toBe('failed_code');
    expect(checkCodeBlock(SNIPPET.split('\n'), ['S1'], byId)).toBeNull();
    expect(checkCodeBlock(SNIPPET.split('\n'), [], byId)).toBe('failed_code');
  });

  it('leaves v2 behavior unchanged: fences are plain lines', () => {
    const outcome = validateAnswer(
      { answer: `Change it [1]:\n\`\`\`html\n${SNIPPET}\n\`\`\``, citations: [{ marker: 1, source_id: 'S1', quote: lead.quote }] },
      SOURCES,
      { requireMarkers: true },
    );
    expect(outcome.removedSentences.every((s) => s.reason === 'unmarked_claim')).toBe(true);
    expect(outcome.answer).not.toContain('window.plausible');
  });
});
