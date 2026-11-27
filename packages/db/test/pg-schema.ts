import pg from 'pg';
import { PgDb } from '../src/node/pg-db.ts';

/** Set by `pnpm test:db`; without it the Postgres-backed tests are skipped. */
export const PG_TEST_URL = process.env.PG_TEST_URL;

/** Adds `search_path=<schema>,public` to a connection string (public keeps the vector type). */
export function withSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${schema},public`);
  return u.toString();
}

/**
 * A throw-away schema with every migration applied. Drop it with `drop()`.
 * The dev database's own tables are never touched.
 */
export async function temporarySchema(baseUrl: string, prefix: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const schema = `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = withSearchPath(baseUrl, schema);
  const db = new PgDb(url);
  try {
    await db.migrate();
  } finally {
    await db.close();
  }
  return {
    url,
    drop: async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
