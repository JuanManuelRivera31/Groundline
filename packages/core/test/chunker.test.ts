import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../src/chunking/chunker.ts';
import { estimateTokens } from '../src/tokens.ts';

const sentence = (i: number): string => `Sentence number ${i} explains one billing detail in plain words.`;
const paragraph = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');

/** Keep every section separate to test heading logic in isolation. */
const SEPARATE = { mergeSubtrees: false } as const;

describe('chunkDocument: sections and headings', () => {
  it('builds heading paths that always start with the document title', () => {
    const body = ['# Billing FAQ', 'Intro text.', '## Refunds', 'Refund text.', '### Duplicate charge', 'Charged twice text.'].join('\n\n');
    const { title, chunks } = chunkDocument({ body, title: 'Billing FAQ', fallbackTitle: 'billing' }, SEPARATE);
    expect(title).toBe('Billing FAQ');
    expect(chunks.map((c) => [c.headingPath, c.anchor])).toEqual([
      ['Billing FAQ', null],
      ['Billing FAQ > Refunds', 'refunds'],
      ['Billing FAQ > Refunds > Duplicate charge', 'duplicate-charge'],
    ]);
    expect(chunks[2]?.embedText).toBe('Billing FAQ > Refunds > Duplicate charge\n\nCharged twice text.');
  });

  it('falls back to the H1, then to the file name, for the title', () => {
    expect(chunkDocument({ body: '# From H1\n\nText', fallbackTitle: 'file' }).chunks[0]?.headingPath).toBe('From H1');
    expect(chunkDocument({ body: 'Just text', fallbackTitle: 'file' }).chunks[0]?.headingPath).toBe('file');
  });

  it('pops the heading stack when a shallower heading appears', () => {
    const body = '## A\n\na\n\n### A1\n\na1\n\n## B\n\nb';
    const paths = chunkDocument({ body, title: 'Doc', fallbackTitle: 'x' }, SEPARATE).chunks.map((c) => c.headingPath);
    expect(paths).toEqual(['Doc > A', 'Doc > A > A1', 'Doc > B']);
  });

  it('never emits a heading-only chunk: empty sections merge into the next one', () => {
    const body = '## Parent\n\n### Child\n\nChild body.\n\n## Empty sibling\n\n## Next\n\nNext body.\n\n## Trailing empty';
    const { chunks } = chunkDocument({ body, title: 'Doc', fallbackTitle: 'x' }, SEPARATE);
    expect(chunks.map((c) => c.headingPath)).toEqual(['Doc > Parent > Child', 'Doc > Next']);
    expect(chunks[1]?.content).toBe('## Empty sibling\n\nNext body.');
    expect(chunks.every((c) => c.content.trim() !== '')).toBe(true);
  });

  it('generates Docusaurus-style anchors with duplicate suffixes and explicit ids', () => {
    const body = '## Setup\n\none\n\n## Setup\n\ntwo\n\n## Custom {#my-id}\n\nthree\n\n## What’s new? (2024)\n\nfour';
    const anchors = chunkDocument({ body, title: 'Doc', fallbackTitle: 'x' }, SEPARATE).chunks.map((c) => c.anchor);
    expect(anchors).toEqual(['setup', 'setup-1', 'my-id', 'whats-new-2024']);
  });

  it('assigns consecutive ords across the document', () => {
    const body = '## A\n\na\n\n## B\n\nb\n\n## C\n\nc';
    expect(chunkDocument({ body, title: 'Doc', fallbackTitle: 'x' }, SEPARATE).chunks.map((c) => c.ord)).toEqual([0, 1, 2]);
  });
});

describe('chunkDocument: merging small subtrees', () => {
  it('folds small descendant sections into their parent, keeping the parent anchor', () => {
    const body = ['## Refunds', 'Refund text.', '### Duplicate charge', 'Charged twice text.', '### Timing', 'A few days.'].join('\n\n');
    const { chunks } = chunkDocument({ body, title: 'Billing FAQ', fallbackTitle: 'x' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ headingPath: 'Billing FAQ > Refunds', anchor: 'refunds' });
    expect(chunks[0]?.content).toBe('Refund text.\n\n### Duplicate charge\n\nCharged twice text.\n\n### Timing\n\nA few days.');
  });

  it('folds a whole short document into one chunk anchored at the page top', () => {
    const body = '# Cancel\n\nIntro.\n\n## Steps\n\nClick cancel.\n\n## After\n\nData is kept.';
    const { chunks } = chunkDocument({ body, title: 'Cancel', fallbackTitle: 'x' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ headingPath: 'Cancel', anchor: null });
  });

  it('never folds siblings together, so every chunk keeps an exact anchor', () => {
    const body = '## Bounce rate\n\nShort definition.\n\n## Visit duration\n\nAnother short definition.';
    const { chunks } = chunkDocument({ body, title: 'Metrics', fallbackTitle: 'x' });
    expect(chunks.map((c) => c.anchor)).toEqual(['bounce-rate', 'visit-duration']);
  });

  it('stops folding when the budget would be exceeded', () => {
    const body = `## Parent\n\nShort intro.\n\n### Big child\n\n${paragraph(0, 40)}\n\n### Small child\n\nTiny.`;
    const { chunks } = chunkDocument({ body, title: 'Doc', fallbackTitle: 'x' });
    expect(chunks[0]).toMatchObject({ headingPath: 'Doc > Parent', content: 'Short intro.' });
    expect(chunks.some((c) => c.headingPath === 'Doc > Parent > Big child')).toBe(true);
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(500);
  });
});

describe('chunkDocument: packing', () => {
  it('splits long sections within the token budget, with a small overlap', () => {
    const body = `## Long\n\n${Array.from({ length: 12 }, (_, i) => paragraph(i * 8, 8)).join('\n\n')}`;
    const { chunks } = chunkDocument({ body, title: 'Doc', fallbackTitle: 'x' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(500);
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]?.content ?? '';
      const firstPara = chunks[i]?.content.split('\n\n')[0] ?? '';
      expect(previous.endsWith(firstPara)).toBe(true);
      expect(estimateTokens(firstPara)).toBeLessThanOrEqual(60);
    }
  });

  it('splits a single oversized paragraph by sentences and still overlaps', () => {
    const body = `## Wall of text\n\n${paragraph(0, 60)}`;
    const { chunks } = chunkDocument({ body, title: 'Doc', fallbackTitle: 'x' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(500);
    const secondStart = chunks[1]?.content.split('\n\n')[0] ?? '';
    expect(chunks[0]?.content.endsWith(secondStart)).toBe(true);
  });

  it('never cuts a code block or a table, even when it exceeds the budget', () => {
    const bigCode = ['```js', ...Array.from({ length: 200 }, (_, i) => `console.log("line ${i}");`), '```'].join('\n');
    const bigTable = ['| a | b |', '| - | - |', ...Array.from({ length: 150 }, (_, i) => `| row ${i} | value ${i} |`)].join('\n');
    const body = `## Code\n\nBefore.\n\n${bigCode}\n\nAfter.\n\n## Table\n\n${bigTable}`;
    const { chunks } = chunkDocument({ body, title: 'Doc', fallbackTitle: 'x' });
    expect(chunks.some((c) => c.content === bigCode)).toBe(true);
    expect(chunks.some((c) => c.content === bigTable)).toBe(true);
    for (const chunk of chunks) {
      const fences = chunk.content.match(/```/g)?.length ?? 0;
      expect(fences % 2).toBe(0);
    }
  });

  it('cleans MDX before chunking and keeps admonition text', () => {
    const body = [
      "import useBaseUrl from '@docusaurus/useBaseUrl';",
      '',
      '## Track revenue',
      '',
      ':::tip',
      'Revenue is shown in your reporting currency.',
      ':::',
      '',
      "<img alt=\"Revenue goal\" src={useBaseUrl('img/goal.png')} />",
    ].join('\n');
    const { chunks } = chunkDocument({ body, title: 'Ecommerce', fallbackTitle: 'x' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('Tip:\nRevenue is shown in your reporting currency.\n\nRevenue goal');
  });
});
