import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Minimal client surface so the runner can be tested without Postgres. */
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

const MIGRATION_FILE = /^(\d{4})_[\w-]+\.sql$/;
// Arbitrary constant key for pg_advisory_lock so concurrent runners serialize.
const ADVISORY_LOCK_KEY = 727_001;

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => MIGRATION_FILE.test(file)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(dir, file), 'utf8');
      return { version: file.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

/**
 * Applies pending migrations in order, each in its own transaction, under an
 * advisory lock. Idempotent: applied versions are skipped, and an applied
 * migration whose file changed aborts the run (migrations are append-only).
 */
export async function runMigrations(client: MigrationClient, migrations: readonly Migration[]): Promise<MigrationResult> {
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const known = new Map(rows.map((row) => [String(row.version), String(row.checksum)]));

    const applied: string[] = [];
    const alreadyApplied: string[] = [];
    for (const migration of migrations) {
      const checksum = known.get(migration.version);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new Error(`Migration ${migration.version} was modified after being applied. Add a new migration instead.`);
        }
        alreadyApplied.push(migration.version);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          migration.version,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(migration.version);
    }
    return { applied, alreadyApplied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}
