import { cleanProse } from './clean.ts';

/** Atomic units of a document. Code and table blocks are never split. */
export type Block =
  | { readonly kind: 'heading'; readonly depth: number; readonly text: string; readonly explicitId: string | undefined }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'table'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string };

interface Segment {
  readonly type: 'code' | 'prose';
  readonly text: string;
}

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const EXPLICIT_ID = /[ \t]*\{#([^}\s]+)\}[ \t]*$/;
const ADMONITION_OPEN = /^[ \t]*:::[ \t]*([A-Za-z]+)(?:\[([^\]]*)\])?[ \t]*(.*)$/;
const ADMONITION_CLOSE = /^[ \t]*:::[ \t]*$/;
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)+\|?[ \t]*$/;
const THEMATIC_BREAK = /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/** Splits a body into fenced code segments (verbatim) and prose segments. */
function splitSegments(body: string): Segment[] {
  const lines = body.split('\n');
  const segments: Segment[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    if (prose.length > 0) segments.push({ type: 'prose', text: prose.join('\n') });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const open = FENCE_OPEN.exec(line);
    const marker = open?.[2];
    if (!open || marker === undefined || (marker.startsWith('`') && (open[3] ?? '').includes('`'))) {
      prose.push(line);
      continue;
    }

    flushProse();
    const indent = open[1]?.length ?? 0;
    const fenceChar = marker.charAt(0);
    // Fence characters (` and ~) need no regex escaping.
    const closing = new RegExp(`^[ \\t]*${fenceChar}{${marker.length},}[ \\t]*$`);
    const code: string[] = [line.slice(indent)];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const inner = lines[j] ?? '';
      code.push(dedent(inner, indent));
      if (closing.test(inner)) break;
    }
    segments.push({ type: 'code', text: code.join('\n') });
    i = j;
  }
  flushProse();
  return segments;
}

function dedent(line: string, indent: number): string {
  let k = 0;
  while (k < indent && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}

function admonitionLabel(type: string, bracketTitle: string | undefined, inlineTitle: string | undefined): string {
  const label = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
  const title = (bracketTitle ?? inlineTitle ?? '').trim();
  return title ? `${label}: ${title}` : `${label}:`;
}

function scanProse(text: string, blocks: Block[]): void {
  const lines = text.split('\n');
  let paragraph: string[] = [];

  const flush = (): void => {
    const joined = paragraph.join('\n').trim();
    if (joined) blocks.push({ kind: 'text', text: joined });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.trim() === '' || THEMATIC_BREAK.test(line)) {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading?.[1] && heading[2]) {
      flush();
      let headingText = heading[2];
      const id = EXPLICIT_ID.exec(headingText);
      if (id) headingText = headingText.slice(0, id.index);
      headingText = headingText.trim();
      if (headingText) blocks.push({ kind: 'heading', depth: heading[1].length, text: headingText, explicitId: id?.[1] });
      continue;
    }

    if (ADMONITION_CLOSE.test(line)) {
      flush();
      continue;
    }
    const admonition = ADMONITION_OPEN.exec(line);
    if (admonition?.[1]) {
      flush();
      paragraph.push(admonitionLabel(admonition[1], admonition[2], admonition[3]));
      continue;
    }

    const next = lines[i + 1] ?? '';
    const startsTable = line.trimStart().startsWith('|') || (line.includes('|') && TABLE_SEPARATOR.test(next));
    if (startsTable) {
      flush();
      const rows: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const row = lines[j] ?? '';
        if (row.trim() === '' || !row.includes('|')) break;
        rows.push(row.trim());
      }
      blocks.push({ kind: 'table', text: rows.join('\n') });
      i = j - 1;
      continue;
    }

    paragraph.push(line);
  }
  flush();
}

/** Parses a Markdown/MDX body (without frontmatter) into atomic blocks. */
export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  for (const segment of splitSegments(body)) {
    if (segment.type === 'code') blocks.push({ kind: 'code', text: segment.text });
    else scanProse(cleanProse(segment.text), blocks);
  }
  return blocks;
}
