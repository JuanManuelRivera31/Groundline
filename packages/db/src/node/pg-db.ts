import pg from 'pg';
import { PgQueries, type PgConnection } from '../pg-queries.ts';
import { loadMigrations, runMigrations, type MigrationResult } from './migrate.ts';

/** Node adapter: one pg.Pool over TCP (local Docker Postgres). */
export class PgDb extends PgQueries {
  readonly #pool: pg.Pool;

  constructor(connectionString: string) {
    super();
    this.#pool = new pg.Pool({ connectionString, max: 4 });
  }

  async migrate(): Promise<MigrationResult> {
    const client = await this.#pool.connect();
    try {
      return await runMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
  }

  protected run<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.#pool.query<R>(text, values);
  }

  protected async withConnection<T>(fn: (connection: PgConnection) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
