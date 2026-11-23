import { describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations, type Migration, type MigrationClient } from '../src/node/migrate.ts';
import { parseVectorLiteral, toVectorLiteral } from '../src/vector.ts';

/** Records SQL and simulates schema_migrations in memory. No Postgres needed. */
class FakeClient implements MigrationClient {
  readonly statements: string[] = [];
  readonly applied = new Map<string, string>();
  failOn: string | undefined;

  query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.statements.push(sql.trim().split('\n')[0] ?? '');
    if (this.failOn && sql.includes(this.failOn)) return Promise.reject(new Error('boom'));
    if (sql.startsWith('SELECT version, checksum')) {
      return Promise.resolve({ rows: [...this.applied].map(([version, checksum]) => ({ version, checksum })) });
    }
    if (sql.startsWith('INSERT INTO schema_migrations')) this.applied.set(String(params[0]), String(params[1]));
    return Promise.resolve({ rows: [] });
  }
}

const m = (version: string, sql: string, checksum = version): Migration => ({ version, sql, checksum });

describe('runMigrations', () => {
  it('applies pending migrations in order, each in a transaction, under an advisory lock', async () => {
    const client = new FakeClient();
    const result = await runMigrations(client, [m('0001_a', 'CREATE TABLE a ()'), m('0002_b', 'CREATE TABLE b ()')]);
    expect(result).toEqual({ applied: ['0001_a', '0002_b'], alreadyApplied: [] });
    expect(client.statements[0]).toContain('pg_advisory_lock');
    expect(client.statements.at(-1)).toContain('pg_advisory_unlock');
    expect(client.statements.filter((s) => s === 'BEGIN')).toHaveLength(2);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const client = new FakeClient();
    const migrations = [m('0001_a', 'CREATE TABLE a ()')];
    await runMigrations(client, migrations);
    expect(await runMigrations(client, migrations)).toEqual({ applied: [], alreadyApplied: ['0001_a'] });
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const client = new FakeClient();
    await runMigrations(client, [m('0001_a', 'CREATE TABLE a ()', 'sum-1')]);
    await expect(runMigrations(client, [m('0001_a', 'CREATE TABLE a (x int)', 'sum-2')])).rejects.toThrow(/modified/);
    expect(client.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('rolls back a failing migration and does not record it', async () => {
    const client = new FakeClient();
    client.failOn = 'CREATE TABLE broken';
    await expect(runMigrations(client, [m('0001_broken', 'CREATE TABLE broken ()')])).rejects.toThrow('boom');
    expect(client.statements).toContain('ROLLBACK');
    expect(client.applied.size).toBe(0);
  });

  it('loads the repository migrations with stable checksums', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((x) => x.version)).toEqual(['0001_init', '0002_api_usage_tokens']);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[0]?.sql).toContain("coalesce(heading_path, '')");
    expect(migrations[0]?.sql).toContain('vector_cosine_ops');
    expect(migrations[0]?.sql).toContain('CREATE TABLE api_usage');
    expect(migrations[1]?.sql).toContain('ADD COLUMN prompt_tokens');
  });
});

describe('vector literals', () => {
  it('round-trips pgvector text format', () => {
    expect(toVectorLiteral([0.5, -1, 2e-7])).toBe('[0.5,-1,2e-7]');
    expect(parseVectorLiteral('[0.5,-1,2e-7]')).toEqual([0.5, -1, 2e-7]);
    expect(() => toVectorLiteral([Number.NaN])).toThrow();
  });
});
