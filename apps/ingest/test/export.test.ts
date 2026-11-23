import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/corpus.ts';
import { chunkId, exportChunks, toJsonl } from '../src/export.ts';
import type { SourceDefinition } from '../src/sources/index.ts';

const source: SourceDefinition = {
  key: 'fixture',
  name: 'Fixture docs',
  repoUrl: 'https://example.test/docs.git',
  commit: '0'.repeat(40),
  docsDir: 'docs',
  license: 'CC-BY-SA-4.0',
  site: { siteUrl: 'https://docs.example.test', baseUrl: '/docs/', routeBasePath: '/' },
};
const FIXTURE_REPO = join(import.meta.dirname, 'fixtures', 'repo');

describe('exportChunks', () => {
  it('exports one row per chunk with stable ids and citation URLs', async () => {
    const corpus = await loadCorpus(source, FIXTURE_REPO);
    const rows = await exportChunks(corpus);
    expect(rows.map((r) => [r.doc_path, r.heading_path, r.url])).toEqual([
      ['guides/setup.md', 'Setup guide', 'https://docs.example.test/docs/start-here'],
      ['refunds.md', 'Refund policy', 'https://docs.example.test/docs/refunds'],
    ]);
    for (const row of rows) expect(row.id).toMatch(/^c_[0-9a-f]{16}$/);
    // Same corpus, same ids.
    expect((await exportChunks(await loadCorpus(source, FIXTURE_REPO))).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('changes the id when the chunk text changes', async () => {
    expect(await chunkId('a.md', 0, 'h1')).not.toBe(await chunkId('a.md', 0, 'h2'));
    expect(await chunkId('a.md', 0, 'h1')).not.toBe(await chunkId('a.md', 1, 'h1'));
  });

  it('serializes JSON lines', () => {
    expect(toJsonl([{ a: 1 }, { b: 'x' }])).toBe('{"a":1}\n{"b":"x"}\n');
    expect(toJsonl([])).toBe('');
  });
});
