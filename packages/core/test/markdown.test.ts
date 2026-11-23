import { describe, expect, it } from 'vitest';
import { cleanProse } from '../src/markdown/clean.ts';
import { parseBlocks } from '../src/markdown/blocks.ts';
import { splitFrontmatter } from '../src/markdown/frontmatter.ts';

describe('splitFrontmatter', () => {
  it('parses YAML frontmatter and normalizes CRLF', () => {
    const { data, body } = splitFrontmatter('---\r\ntitle: Billing FAQ\r\nslug: /billing\r\n---\r\nHello\r\n');
    expect(data).toEqual({ title: 'Billing FAQ', slug: '/billing' });
    expect(body).toBe('Hello\n');
  });

  it('returns the whole text when there is no frontmatter', () => {
    expect(splitFrontmatter('# Title\n').body).toBe('# Title\n');
  });
});

describe('cleanProse (MDX)', () => {
  it('drops imports, exports and JSX components but keeps their text', () => {
    const input = [
      "import useBaseUrl from '@docusaurus/useBaseUrl';",
      "import { CtaBox } from '@site/src/components/CtaBox';",
      'export const meta = { a: 1 };',
      '<CtaBox title="Try it" />',
      '<details><summary>Show more</summary>Hidden text</details>',
    ].join('\n');
    const out = cleanProse(input);
    expect(out).not.toMatch(/import|export|CtaBox|<\/?details>/);
    expect(out).toContain('Show more');
    expect(out).toContain('Hidden text');
  });

  it('removes <head> blocks with JSON-LD and JSX expressions', () => {
    const input = '<head>\n<script type="application/ld+json">{`{"@type": "FAQPage"}`}</script>\n</head>\nVisible {props.value} text';
    expect(cleanProse(input).trim()).toBe('Visible  text');
  });

  it('keeps non-empty image alt text and drops images without alt', () => {
    const input = [
      '![Plan settings page](/img/plan.png)',
      '![](/img/empty.png)',
      "<img alt=\"Revenue chart\" src={useBaseUrl('/img/rev.png')} />",
      "<img src={useBaseUrl('/img/no-alt.png')} />",
    ].join('\n');
    const lines = cleanProse(input).split('\n');
    expect(lines).toEqual(['Plan settings page', '', 'Revenue chart', '']);
  });

  it('reduces links to their text', () => {
    expect(cleanProse('See [change your plan](change-plan.md#upgrade) now.')).toBe('See change your plan now.');
  });

  it('protects inline code, including tag-like content', () => {
    const input = 'Paste the `<script>` tag into your `<head>` section.';
    expect(cleanProse(input)).toBe(input);
  });

  it('keeps escaped braces', () => {
    expect(cleanProse('Use \\{name\\} as a placeholder')).toBe('Use {name} as a placeholder');
  });
});

describe('parseBlocks', () => {
  it('keeps code fences verbatim, even with # lines and tags inside', () => {
    const body = ['## Install', '', '```html', '# not a heading', '<script defer src="x.js"></script>', '```', 'After.'].join('\n');
    const blocks = parseBlocks(body);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'code', 'text']);
    expect(blocks[1]?.text).toBe('```html\n# not a heading\n<script defer src="x.js"></script>\n```');
  });

  it('parses tables as a single block', () => {
    const body = 'Intro\n\n| Provider | Format |\n| --- | --- |\n| Stripe | cents |\n| Paddle | units |\n\nAfter';
    const blocks = parseBlocks(body);
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'table', 'text']);
    expect(blocks[1]?.text.split('\n')).toHaveLength(4);
  });

  it('turns admonitions into labelled text', () => {
    const blocks = parseBlocks(':::tip Pro tip\nUse goals.\n:::\n\n:::note\nRefunds are not tracked.\n:::');
    expect(blocks).toEqual([
      { kind: 'text', text: 'Tip: Pro tip\nUse goals.' },
      { kind: 'text', text: 'Note:\nRefunds are not tracked.' },
    ]);
  });

  it('supports explicit heading ids in CommonMark and MDX comment form', () => {
    const blocks = parseBlocks('## First {#custom-one}\n\n### Second {/* #custom-two */}');
    expect(blocks).toEqual([
      { kind: 'heading', depth: 2, text: 'First', explicitId: 'custom-one' },
      { kind: 'heading', depth: 3, text: 'Second', explicitId: 'custom-two' },
    ]);
  });

  it('handles tilde fences and fences inside admonitions', () => {
    const blocks = parseBlocks(':::warning\nCareful:\n\n~~~js\nconst a = 1;\n~~~\n:::');
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'code']);
  });
});
