import pg from 'pg';
import { PgQueries, type PgConnection } from '../pg-queries.ts';

/**
 * Workers adapter (ADR-0002, ADR-0013): one pg.Client per request, connected
 * lazily on the first query and closed by `close()` when the request ends.
 * On Cloudflare Workers, pg opens its socket through `cloudflare:sockets`
 * (nodejs_compat); on Node the same class runs over TCP, which is how it is
 * tested against the local Postgres. No Node APIs here.
 */
export class ClientDb extends PgQueries {
  readonly #client: pg.Client;
  #connecting: Promise<void> | undefined;
  #closed = false;
  /** Serializes statements and transactions, so a transaction never interleaves with another query on the shared client. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(connectionString: string) {
    super();
    this.#client = new pg.Client({ connectionString });
  }

  #connected(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('ClientDb is closed.'));
    this.#connecting ??= this.#client.connect().then(() => undefined);
    return this.#connecting;
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  protected run<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.#exclusive(async () => {
      await this.#connected();
      return this.#client.query<R>(text, values);
    });
  }

  protected withConnection<T>(fn: (connection: PgConnection) => Promise<T>): Promise<T> {
    return this.#exclusive(async () => {
      await this.#connected();
      return fn(this.#client);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#queue;
    this.#closed = true;
    // Never connected: nothing to close.
    if (!this.#connecting) return;
    await this.#connecting.catch(() => undefined);
    await this.#client.end();
  }
}
