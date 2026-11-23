# ADR-0002: PostgreSQL + pgvector, `pg` driver behind a `Db` interface

- Status: Accepted
- Date: 2026-11-22

## Context

Retrieval needs vector search and full-text search over the same rows. The demo runs locally on Docker and later on Neon's Free plan, which needs no card. The API will run on Cloudflare Workers (Free plan).

## Decision

- **PostgreSQL 18 + pgvector 0.8.7**. Locally that is the official image `pgvector/pgvector:0.8.7-pg18`.
  - PostgreSQL 19 came out on 2026-11-19. Postgres 18 is Neon's default and has had a year of patch releases, so dev/prod parity favours 18.
  - The volume mounts at `/var/lib/postgresql`, as the Postgres 18+ images require.
  - The host port defaults to **54329** (`PG_PORT`) so it never collides with another local Postgres on 5431/5432. It binds to 127.0.0.1 only.
- **Schema** (`packages/db/migrations/0001_init.sql`):
  - Tables: `sources`, `documents`, `chunks`, `embedding_cache`, `ingest_runs`, `api_usage`.
  - `chunks.embedding vector(768)` has an **HNSW** index (`vector_cosine_ops`). HNSW supports up to 2,000 dimensions for `vector`.
  - `chunks.tsv` is a generated `tsvector`, `to_tsvector('english', coalesce(heading_path, '') || ' ' || content)`, with a **GIN** index. The `coalesce` stops a NULL from nulling out the vector.
  - Full-text queries use **OR semantics**: the lexemes of `plainto_tsquery('english', q)` are re-joined with `|` and parsed with the `simple` config so they are not stemmed twice. Results are ranked with `ts_rank_cd`. `websearch_to_tsquery`/`plainto_tsquery` alone AND every term and rarely match natural-language questions.
  - `api_usage` records every Gemini HTTP call. The free-tier daily quota belongs to the Google project, so it is shared by ingestion, `search:debug` and the future API.
- **Migrations**: plain SQL files, applied in order by a small runner. Each file runs in its own transaction under `pg_advisory_lock`, with a checksum recorded in `schema_migrations`. The runner is idempotent and refuses to proceed if an applied migration was edited.
- **Driver**: `pg` (node-postgres) **8.23.1** for both runtimes.
  - It speaks TCP to local Docker Postgres in Node.
  - On Workers it works with `nodejs_compat` (on by default for compatibility dates from 2026-08-04) and `pg` ≥ 8.16.3. It can connect to Neon directly or through Hyperdrive, which is included in all Workers plans.
  - `@neondatabase/serverless` was rejected: it needs a local Neon proxy to talk to plain Docker Postgres.
- **Adapters**: callers depend only on the `Db` interface (`packages/db/src/types.ts`).
  - S1 ships only the Node adapter (`PgDb`, a `pg.Pool`).
  - The Workers adapter has a different lifecycle (a `Client` created and closed within each request). It will be written and tested in the deployment session; no untested code ships now.

## Consequences

- Changing `EMBEDDING_DIMS` requires a new migration. Ingestion refuses to run when `chunks.embedding` does not match the configured dimensions.
- `embedding_cache.embedding` is an unconstrained `vector`, so vectors from several models or dimensions can coexist. Re-embedding after a model switch is cache-driven.

## Sources

- pgvector (HNSW limits, version): https://github.com/pgvector/pgvector · image tags: https://hub.docker.com/r/pgvector/pgvector/tags
- Postgres versions: https://www.postgresql.org/support/versioning/ · Docker volume change in 18: https://hub.docker.com/_/postgres
- Neon Postgres versions (18 default): https://neon.com/docs/reference/compatibility · pgvector on Neon: https://neon.com/docs/extensions/pgvector · plans: https://neon.com/docs/introduction/plans
- Neon serverless driver (local proxy requirement): https://neon.com/docs/serverless/serverless-driver
- `pg` on Workers: https://developers.cloudflare.com/workers/tutorials/postgres/ · https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/ · https://neon.com/docs/guides/cloudflare-workers
