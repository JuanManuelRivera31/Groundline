import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingClient, parseConfig, QuotaExceededError } from '@groundline/core';
import { loadCorpus } from '../src/corpus.ts';
import { runIngest, type IngestDeps } from '../src/pipeline.ts';
import type { SourceDefinition } from '../src/sources/index.ts';
import { chunkQualityStats, mulberry32, sampleChunks } from '../src/stats.ts';
import { MemoryDb } from './memory-db.ts';

const FIXTURE_REPO = join(import.meta.dirname, 'fixtures', 'repo');

const source: SourceDefinition = {
  key: 'fixture',
  name: 'Fixture docs',
  repoUrl: 'https://example.test/docs.git',
  commit: '0'.repeat(40),
  docsDir: 'docs',
  license: 'CC-BY-SA-4.0',
  site: { siteUrl: 'https://docs.example.test', baseUrl: '/docs/', routeBasePath: '/' },
};

function deps(db: MemoryDb, client: FakeEmbeddingClient | undefined, env: Record<string, string> = {}): IngestDeps {
  let now = Date.UTC(2026, 10, 22, 18, 0, 0);
  return {
    db,
    config: parseConfig({ EMBEDDING_MODEL: 'fake-embedding', EMBEDDING_DIMS: '8', ...env }),
    client,
    clock: { now: () => now },
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    random: () => 0.5,
    log: () => undefined,
  };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadCorpus', () => {
  it('maps URLs, skips partials and drafts, and keeps anchors for citations', async () => {
    const corpus = await loadCorpus(source, FIXTURE_REPO);
    expect(corpus.documents.map((d) => [d.path, d.url])).toEqual([
      ['guides/setup.md', 'https://docs.example.test/docs/start-here'],
      ['refunds.md', 'https://docs.example.test/docs/refunds'],
    ]);
    expect(corpus.skipped).toEqual([{ path: 'draft.md', reason: 'draft' }]);

    const refunds = corpus.documents.find((d) => d.path === 'refunds.md');
    expect(refunds?.chunks.map((c) => [c.headingPath, c.url])).toEqual([
      ['Refund policy', 'https://docs.example.test/docs/refunds'],
      ['Refund policy > Duplicate charges', 'https://docs.example.test/docs/refunds#duplicate-charges'],
      ['Refund policy > Request a refund', 'https://docs.example.test/docs/refunds#request-a-refund'],
    ]);
    const duplicate = refunds?.chunks[1]?.content ?? '';
    expect(duplicate).toContain('Note:\nRefunds can take a few business days');
    expect(duplicate).toContain('Refund form');
    expect(refunds?.chunks[2]?.content).toContain('## Empty section');
    expect(refunds?.chunks[2]?.content).toContain('```bash');
  });
});

describe('runIngest', () => {
  it('embeds on the first run and makes zero API calls on the second', async () => {
    const corpus = await loadCorpus(source, FIXTURE_REPO);
    const db = new MemoryDb();
    const client = new FakeEmbeddingClient({ dimensions: 8, maxBatchSize: 20 });

    const first = await runIngest(deps(db, client), source, corpus, source.commit, { dryRun: false });
    expect(first.estimate).toMatchObject({ documents: 2, chunks: 4, cacheHits: 0, textsToEmbed: 4 });
    expect(first.embed).toMatchObject({ httpCalls: 1, quotaRequests: 4 });
    expect(first.sync).toMatchObject({ documentsInserted: 2, chunksInserted: 4 });
    expect(db.usage.map((u) => [u.kind, u.requests, u.ingestRunId])).toEqual([['embed_document', 4, first.runId]]);

    const second = await runIngest(deps(db, undefined), source, corpus, source.commit, { dryRun: false });
    expect(client.calls).toHaveLength(1);
    expect(second.embed).toBeNull();
    expect(second.estimate).toMatchObject({ cacheHits: 4, textsToEmbed: 0, quotaRequests: 0 });
    expect(second.sync).toMatchObject({ chunksInserted: 0, chunksUpdated: 0, chunksUnchanged: 4, chunksDeleted: 0 });
    const run = db.runs.get(second.runId ?? -1);
    expect(run).toMatchObject({ status: 'succeeded', apiCalls: 0, apiRequests: 0, cacheHits: 4, embeddingModel: 'fake-embedding', embeddingDims: 8 });
  });

  it('deletes documents that disappeared from the source and re-embeds only changed text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'groundline-'));
    tempDirs.push(dir);
    await cp(FIXTURE_REPO, dir, { recursive: true });
    const db = new MemoryDb();
    const client = new FakeEmbeddingClient({ dimensions: 8, maxBatchSize: 20 });
    await runIngest(deps(db, client), source, await loadCorpus(source, dir), source.commit, { dryRun: false });

    await rm(join(dir, 'docs', 'guides'), { recursive: true });
    await writeFile(join(dir, 'docs', 'new.md'), '---\ntitle: New page\n---\n\nBrand new content.\n');
    const result = await runIngest(deps(db, client), source, await loadCorpus(source, dir), source.commit, { dryRun: false });

    expect(result.embed?.quotaRequests).toBe(1);
    expect(result.sync).toMatchObject({ documentsInserted: 1, documentsDeleted: 1, chunksDeleted: 1, chunksUnchanged: 3 });
    expect([...db.documents.keys()].sort()).toEqual(['new.md', 'refunds.md']);
  });

  it('dry run estimates without API calls or writes, and works without an API key', async () => {
    const db = new MemoryDb();
    const result = await runIngest(deps(db, undefined), source, await loadCorpus(source, FIXTURE_REPO), source.commit, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.estimate).toMatchObject({ textsToEmbed: 4, quotaRequests: 4, httpCalls: 1, remainingToday: 800 });
    expect(db.documents.size).toBe(0);
    expect(db.usage).toHaveLength(0);
  });

  it('stops before calling the API when the daily quota cannot cover the run', async () => {
    const db = new MemoryDb();
    const client = new FakeEmbeddingClient({ dimensions: 8 });
    const run = runIngest(deps(db, client, { GEMINI_EMBED_RPD: '3' }), source, await loadCorpus(source, FIXTURE_REPO), source.commit, { dryRun: false });
    await expect(run).rejects.toBeInstanceOf(QuotaExceededError);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses to run when the embedding column does not match EMBEDDING_DIMS', async () => {
    const db = new MemoryDb();
    db.columnDims = 768;
    await expect(
      runIngest(deps(db, new FakeEmbeddingClient({ dimensions: 8 })), source, await loadCorpus(source, FIXTURE_REPO), source.commit, { dryRun: false }),
    ).rejects.toThrow(/vector\(768\)/);
  });
});

describe('chunk quality stats', () => {
  it('summarizes token distribution and samples deterministically', async () => {
    const corpus = await loadCorpus(source, FIXTURE_REPO);
    const stats = chunkQualityStats(corpus);
    expect(stats).toMatchObject({ documents: 2, chunks: 4 });
    expect(stats.tokens.min).toBeLessThanOrEqual(stats.tokens.median);
    expect(stats.tokens.p95).toBeLessThanOrEqual(stats.tokens.max);
    expect(stats.topDocuments[0]).toEqual({ path: 'refunds.md', chunks: 3 });
    const a = sampleChunks(corpus, 2, mulberry32(7)).map((c) => c.url);
    const b = sampleChunks(corpus, 2, mulberry32(7)).map((c) => c.url);
    expect(a).toEqual(b);
  });
});
