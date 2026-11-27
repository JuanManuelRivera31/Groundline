// `pnpm test:db`: runs the Postgres-backed tests against the local Docker
// database (pnpm db:up && pnpm db:migrate first). Each test file works in its own
// temporary schema and drops it afterwards, so the dev data is never touched.
// The default `pnpm test` skips these files (no PG_TEST_URL), like CI.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
/** The trimmed value, or undefined when unset or blank. */
const setting = (name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};
const url =
  setting('PG_TEST_URL') ??
  setting('DATABASE_URL') ??
  `postgres://${setting('POSTGRES_USER') ?? 'groundline'}:${setting('POSTGRES_PASSWORD') ?? 'groundline'}@127.0.0.1:${setting('PG_PORT') ?? '54329'}/${setting('POSTGRES_DB') ?? 'groundline'}`;
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('test:db only runs against a local database (127.0.0.1 or localhost).');
  process.exit(1);
}

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', 'packages/db/test/pg', 'apps/api/test/pg'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...env, PG_TEST_URL: url },
});
process.exit(result.status ?? 1);
