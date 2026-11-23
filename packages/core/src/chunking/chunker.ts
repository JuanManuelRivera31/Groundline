import GithubSlugger from 'github-slugger';
import { parseBlocks, type Block } from '../markdown/blocks.ts';
import { estimateTokens } from '../tokens.ts';

export interface ChunkOptions {
  /** Hard ceiling for a chunk's embed text, unless a single code block or table is larger. */
  readonly maxTokens: number;
  /** Maximum size of the overlap carried from the previous chunk of the same section. */
  readonly overlapTokens: number;
  /** A trailing piece smaller than this is merged into the previous chunk when it fits. */
  readonly minTailTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 500,
  overlapTokens: 60,
  minTailTokens: 120,
};

export const HEADING_SEPARATOR = ' > ';

export interface DraftChunk {
  /** 0-based position within the document. */
  readonly ord: number;
  /** "Doc title > Section > Subsection"; always starts with the document title. */
  readonly headingPath: string;
  /** Heading id to cite (`url#anchor`); null for the document top. */
  readonly anchor: string | null;
  /** Cleaned Markdown shown to users and indexed for full-text search. */
  readonly content: string;
  /** Text sent to the embedding model: heading path + blank line + content. */
  readonly embedText: string;
  /** Estimated tokens of embedText. */
  readonly tokens: number;
}

export interface ChunkDocumentInput {
  readonly body: string;
  /** Title from frontmatter, if any. */
  readonly title?: string | undefined;
  /** Used when there is neither a frontmatter title nor an H1. */
  readonly fallbackTitle: string;
}

export interface ChunkedDocument {
  readonly title: string;
  readonly chunks: readonly DraftChunk[];
}

interface Section {
  readonly trail: readonly string[];
  readonly anchor: string | null;
  readonly depth: number;
  readonly heading: string | undefined;
  readonly blocks: Block[];
}

interface Piece {
  readonly kind: 'text' | 'code' | 'table';
  readonly text: string;
  readonly tokens: number;
  readonly overlap: boolean;
}

const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

function buildSections(blocks: readonly Block[], title: string): Section[] {
  const slugger = new GithubSlugger();
  const sections: Section[] = [];
  let stack: { depth: number; text: string }[] = [];
  let current: Section = { trail: [title], anchor: null, depth: 0, heading: undefined, blocks: [] };

  for (const block of blocks) {
    if (block.kind !== 'heading') {
      current.blocks.push(block);
      continue;
    }
    sections.push(current);
    const generated = block.explicitId ?? slugger.slug(block.text);
    if (block.depth === 1 && normalize(block.text) === normalize(title)) {
      // The H1 repeats the document title: it is the document top, not a section.
      stack = [];
      current = { trail: [title], anchor: null, depth: 1, heading: undefined, blocks: [] };
      continue;
    }
    stack = stack.filter((entry) => entry.depth < block.depth);
    stack.push({ depth: block.depth, text: block.text });
    current = {
      trail: [title, ...stack.map((entry) => entry.text)],
      anchor: generated,
      depth: block.depth,
      heading: block.text,
      blocks: [],
    };
  }
  sections.push(current);
  return sections;
}

const isPrefix = (prefix: readonly string[], full: readonly string[]): boolean =>
  prefix.length <= full.length && prefix.every((part, i) => part === full[i]);

/**
 * A section without body is never emitted on its own: it is merged into the
 * next section. Its heading survives either in the next section's heading path
 * (when it is an ancestor) or as a heading line prepended to the next body.
 */
function mergeEmptySections(sections: readonly Section[]): Section[] {
  const result: Section[] = [];
  let pending: Section[] = [];
  for (const section of sections) {
    if (section.blocks.length === 0) {
      pending.push(section);
      continue;
    }
    const carried: Block[] = pending
      .filter((empty) => empty.heading !== undefined && !isPrefix(empty.trail, section.trail))
      .map((empty) => ({ kind: 'text', text: `${'#'.repeat(Math.max(empty.depth, 2))} ${empty.heading ?? ''}` }));
    result.push({ ...section, blocks: [...carried, ...section.blocks] });
    pending = [];
  }
  return result;
}

const SENTENCE_BOUNDARY = /(?<=[.!?:])\s+(?=[A-Z0-9"'(*[`-])/;

/** Splits an oversized text block by lines, then sentences, then words. */
function splitText(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const units = text.includes('\n') ? text.split('\n') : text.split(SENTENCE_BOUNDARY);
  if (units.length === 1) {
    const words = text.split(/\s+/);
    if (words.length === 1) return [text];
    const half = Math.ceil(words.length / 2);
    return [...splitText(words.slice(0, half).join(' '), maxTokens), ...splitText(words.slice(half).join(' '), maxTokens)];
  }
  const out: string[] = [];
  let buffer = '';
  const separator = text.includes('\n') ? '\n' : ' ';
  for (const unit of units) {
    const candidate = buffer ? `${buffer}${separator}${unit}` : unit;
    if (buffer && estimateTokens(candidate) > maxTokens) {
      out.push(...splitText(buffer, maxTokens));
      buffer = unit;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) out.push(...splitText(buffer, maxTokens));
  return out;
}

/** Trailing sentences of a text piece, up to `maxTokens`, used as overlap. */
function overlapTail(piece: Piece, maxTokens: number): Piece | undefined {
  if (piece.kind !== 'text' || maxTokens <= 0) return undefined;
  const sentences = piece.text.split(SENTENCE_BOUNDARY);
  let tail = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    const candidate = tail ? `${sentences[i] ?? ''} ${tail}` : (sentences[i] ?? '');
    if (estimateTokens(candidate) > maxTokens) break;
    tail = candidate;
  }
  return tail ? { kind: 'text', text: tail, tokens: estimateTokens(tail), overlap: true } : undefined;
}

const joinPieces = (pieces: readonly Piece[]): string => pieces.map((p) => p.text).join('\n\n');

function packSection(blocks: readonly Block[], budget: number, options: ChunkOptions): string[] {
  const pieces: Piece[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') continue;
    if (block.kind === 'text') {
      // Leave room for the overlap so a split piece can always follow its predecessor's tail.
      for (const text of splitText(block.text, Math.max(budget - options.overlapTokens, 50))) {
        pieces.push({ kind: 'text', text, tokens: estimateTokens(text), overlap: false });
      }
    } else {
      pieces.push({ kind: block.kind, text: block.text, tokens: estimateTokens(block.text), overlap: false });
    }
  }

  const groups: Piece[][] = [];
  let current: Piece[] = [];
  for (const piece of pieces) {
    const fits = estimateTokens(joinPieces([...current, piece])) <= budget;
    if (current.length > 0 && current.some((p) => !p.overlap) && !fits) {
      groups.push(current);
      const last = current[current.length - 1];
      const tail = last ? overlapTail(last, options.overlapTokens) : undefined;
      current = tail && estimateTokens(joinPieces([tail, piece])) <= budget ? [tail] : [];
    }
    current.push(piece);
  }
  if (current.some((p) => !p.overlap)) groups.push(current);

  // Merge a small trailing group back into its predecessor when it still fits.
  const lastGroup = groups[groups.length - 1];
  const previous = groups[groups.length - 2];
  if (lastGroup && previous) {
    const own = lastGroup.filter((p) => !p.overlap);
    const merged = [...previous, ...own];
    if (estimateTokens(joinPieces(own)) < options.minTailTokens && estimateTokens(joinPieces(merged)) <= budget) {
      groups.splice(groups.length - 2, 2, merged);
    }
  }

  return groups.map(joinPieces).filter((text) => text.trim() !== '');
}

/** Splits a Markdown/MDX document body into heading-aware chunks. */
export function chunkDocument(input: ChunkDocumentInput, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): ChunkedDocument {
  const blocks = parseBlocks(input.body);
  const firstH1 = blocks.find((b) => b.kind === 'heading' && b.depth === 1);
  const title = input.title ?? (firstH1?.kind === 'heading' ? firstH1.text : undefined) ?? input.fallbackTitle;

  const chunks: DraftChunk[] = [];
  for (const section of mergeEmptySections(buildSections(blocks, title))) {
    const headingPath = section.trail.join(HEADING_SEPARATOR);
    const prefixTokens = estimateTokens(`${headingPath}\n\n`);
    const budget = Math.max(options.maxTokens - prefixTokens, 100);
    for (const content of packSection(section.blocks, budget, options)) {
      const embedText = `${headingPath}\n\n${content}`;
      chunks.push({
        ord: chunks.length,
        headingPath,
        anchor: section.anchor,
        content,
        embedText,
        tokens: estimateTokens(embedText),
      });
    }
  }
  return { title, chunks };
}
