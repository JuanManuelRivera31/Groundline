import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCheckout, git } from '../src/git.ts';

// Uses a throwaway local repository (file:// URL), never the network.
describe('ensureCheckout', () => {
  let root: string;
  let originUrl: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'groundline-git-'));
    const origin = join(root, 'origin');
    await git(['init', '-q', '-b', 'main', origin]);
    const commit = async (file: string, message: string): Promise<string> => {
      await writeFile(join(origin, file), `${message}\n`);
      await git(['add', file], origin);
      await git(['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-q', '-m', message], origin);
      return git(['rev-parse', 'HEAD'], origin);
    };
    first = await commit('a.md', 'first');
    second = await commit('b.md', 'second');
    originUrl = pathToFileURL(origin).href;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('clones and populates the working tree even when HEAD already is the pinned commit', async () => {
    const dir = join(root, 'clone-latest');
    const result = await ensureCheckout(originUrl, dir, second);
    expect(result).toMatchObject({ commit: second, cloned: true });
    expect(existsSync(join(dir, 'b.md'))).toBe(true);
  });

  it('moves an existing clone to another commit and is idempotent', async () => {
    const dir = join(root, 'clone-pinned');
    await ensureCheckout(originUrl, dir, second);
    const pinned = await ensureCheckout(originUrl, dir, first);
    expect(pinned).toMatchObject({ commit: first, cloned: false });
    expect(existsSync(join(dir, 'b.md'))).toBe(false);
    expect(await ensureCheckout(originUrl, dir, first)).toMatchObject({ commit: first, cloned: false, fetched: false });
  });

  it('refuses a checkout that points to a different remote', async () => {
    const dir = join(root, 'clone-other');
    await ensureCheckout(originUrl, dir, second);
    await expect(ensureCheckout('https://example.test/other.git', dir, second)).rejects.toThrow(/expected/);
  });
});
