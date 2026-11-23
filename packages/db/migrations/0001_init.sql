-- 0001_init: sources, documents, chunks (pgvector + full-text), embedding cache,
-- ingestion runs and Gemini API usage. Applied once by the migration runner.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE sources (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           text NOT NULL UNIQUE,
  name          text NOT NULL,
  repo_url      text NOT NULL,
  base_url      text NOT NULL,
  license       text,
  pinned_commit text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id    bigint NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  path         text NOT NULL,
  url          text NOT NULL,
  title        text NOT NULL,
  content_hash text NOT NULL,
  commit_sha   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, path)
);

CREATE TABLE chunks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     bigint NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ord             integer NOT NULL,
  heading_path    text NOT NULL,
  anchor          text,
  url             text NOT NULL,
  content         text NOT NULL,
  tokens          integer NOT NULL,
  content_hash    text NOT NULL,
  embedding       vector(768),
  embedding_model text,
  -- coalesce: concatenating a NULL would null out the whole tsvector.
  tsv             tsvector GENERATED ALWAYS AS (
                    to_tsvector('english', coalesce(heading_path, '') || ' ' || content)
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ord)
);

CREATE INDEX chunks_tsv_gin_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);

-- key = sha256(version, model, dimensions, task type, title, text).
-- Unconstrained vector type so other dimensions can be cached side by side.
CREATE TABLE embedding_cache (
  key        text PRIMARY KEY,
  model      text NOT NULL,
  dimensions integer NOT NULL,
  task_type  text NOT NULL,
  embedding  vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingest_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id       bigint REFERENCES sources (id) ON DELETE SET NULL,
  commit_sha      text NOT NULL,
  embedding_model text NOT NULL,
  embedding_dims  integer NOT NULL,
  status          text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  documents       integer,
  chunks          integer,
  tokens          integer,
  api_calls       integer,
  api_requests    integer,
  cache_hits      integer,
  duration_ms     integer,
  error           text
);

-- One row per HTTP call to Gemini (any kind, successful or not). The free-tier
-- daily quota is per Google project, so the limiter sums this table since the
-- last midnight Pacific time. Reused later for per-conversation cost.
CREATE TABLE api_usage (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL,
  model         text NOT NULL,
  requests      integer NOT NULL,
  est_tokens    integer NOT NULL,
  http_status   integer,
  ingest_run_id bigint REFERENCES ingest_runs (id) ON DELETE SET NULL
);

CREATE INDEX api_usage_ts_idx ON api_usage (ts);
