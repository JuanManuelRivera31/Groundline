import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const ENV_FILE = join(REPO_ROOT, '.env');
export const DATA_DIR = join(REPO_ROOT, 'data');

export function corpusDir(sourceKey: string): string {
  return join(DATA_DIR, 'corpus', sourceKey);
}
