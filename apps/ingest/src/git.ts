import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Runs git with an argument array (no shell). Resolves with trimmed stdout. */
export function git(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} failed (exit ${String(code)}): ${stderr.trim()}`));
    });
  });
}

export interface CheckoutResult {
  readonly commit: string;
  readonly cloned: boolean;
  readonly fetched: boolean;
}

/**
 * Ensures `dir` is a clone of `repoUrl` checked out (detached) at `commit`.
 * Uses a blobless partial clone to keep the download small.
 */
export async function ensureCheckout(repoUrl: string, dir: string, commit: string): Promise<CheckoutResult> {
  let cloned = false;
  let fetched = false;
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dirname(dir), { recursive: true });
    await git(['-c', 'core.autocrlf=false', 'clone', '--filter=blob:none', '--no-checkout', repoUrl, dir]);
    await git(['config', 'core.autocrlf', 'false'], dir);
    cloned = true;
  }

  const origin = await git(['remote', 'get-url', 'origin'], dir);
  if (origin !== repoUrl) throw new Error(`${dir} points to ${origin}, expected ${repoUrl}. Remove it and retry.`);

  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], dir).catch(() => '');
  if (head !== commit) {
    const hasCommit = await git(['cat-file', '-e', `${commit}^{commit}`], dir).then(
      () => true,
      () => false,
    );
    if (!hasCommit) {
      await git(['fetch', '--filter=blob:none', 'origin', commit], dir);
      fetched = true;
    }
    await git(['checkout', '--detach', commit], dir);
  }

  const verified = await git(['rev-parse', 'HEAD'], dir);
  if (verified !== commit) throw new Error(`Checkout verification failed: HEAD is ${verified}, expected ${commit}.`);
  return { commit: verified, cloned, fetched };
}
