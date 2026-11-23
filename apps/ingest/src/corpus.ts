import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  chunkDocument,
  docusaurusDocUrl,
  frontmatterString,
  sha256Hex,
  splitFrontmatter,
  withAnchor,
  type DraftChunk,
} from '@groundline/core';
import type { SourceDefinition } from './sources/index.ts';

export interface CorpusChunk extends DraftChunk {
  /** Citation URL including `#anchor`. */
  readonly url: string;
  /** sha256 of embedText. */
  readonly contentHash: string;
}

export interface CorpusDocument {
  /** Path relative to the docs root, POSIX separators. */
  readonly path: string;
  readonly url: string;
  readonly title: string;
  readonly contentHash: string;
  readonly chunks: readonly CorpusChunk[];
}

export interface Corpus {
  readonly documents: readonly CorpusDocument[];
  /** Files skipped (draft, or no indexable text), with the reason. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

const DOC_FILE = /\.mdx?$/i;

/** Lists doc files, skipping `_`-prefixed partials and dot entries like Docusaurus. */
async function listDocFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && DOC_FILE.test(entry.name)) out.push(full);
    }
  };
  await walk(root);
  return out.map((file) => relative(root, file).split(sep).join('/')).sort();
}

/** Parses, maps and chunks every document of a checked-out source. No network. */
export async function loadCorpus(source: SourceDefinition, checkoutDir: string): Promise<Corpus> {
  const docsRoot = join(checkoutDir, source.docsDir);
  const documents: CorpusDocument[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const path of await listDocFiles(docsRoot)) {
    const raw = await readFile(join(docsRoot, path), 'utf8');
    const { data, body } = splitFrontmatter(raw);
    if (data.draft === true) {
      skipped.push({ path, reason: 'draft' });
      continue;
    }

    const url = docusaurusDocUrl(path, { id: data.id, slug: data.slug }, source.site);
    const fallbackTitle = path.replace(DOC_FILE, '').split('/').pop() ?? path;
    const { title, chunks } = chunkDocument({ body, title: frontmatterString(data, 'title'), fallbackTitle });
    if (chunks.length === 0) {
      skipped.push({ path, reason: 'no indexable text' });
      continue;
    }

    const withHashes = await Promise.all(
      chunks.map(async (chunk) => ({
        ...chunk,
        url: withAnchor(url, chunk.anchor),
        contentHash: await sha256Hex(chunk.embedText),
      })),
    );
    documents.push({
      path,
      url,
      title,
      contentHash: await sha256Hex(raw.replace(/\r\n?/g, '\n')),
      chunks: withHashes,
    });
  }
  return { documents, skipped };
}
