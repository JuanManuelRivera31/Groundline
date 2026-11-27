-- 0003_api: demo API conversations, human hand-off cases and per-IP rate-limit
-- events (ADR-0012). No IP address is ever stored: demo_requests keeps only a
-- daily-salted hash. Rows are deleted after RETENTION_DAYS (30 by default).

CREATE TABLE conversations (
  id                  uuid PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- PII-redacted question; NULL when the request was region-blocked.
  question_redacted   text,
  lang                text NOT NULL,
  status              text NOT NULL,
  answer              text NOT NULL,
  -- Cited sources shown to the customer: [{n, title, url, quotes[]}].
  sources             jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Articles shown without an AI answer: [{title, url}].
  articles            jsonb NOT NULL DEFAULT '[]'::jsonb,
  handoff_offered     boolean NOT NULL,
  answered_by         text,
  floor_hit           boolean NOT NULL DEFAULT false,
  hedged              boolean NOT NULL DEFAULT false,
  -- Best retrieved document (gap report grouping) and its similarity.
  nearest_url         text,
  nearest_title       text,
  max_similarity      double precision,
  latency_ms          integer NOT NULL,
  generation_requests integer NOT NULL DEFAULT 0,
  prompt_tokens       integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  thoughts_tokens     integer NOT NULL DEFAULT 0,
  -- Equivalent cost at paid list price; the free tier costs $0.
  cost_usd            double precision,
  -- ISO 3166-1 alpha-2 code only.
  country             text,
  error               text
);

CREATE INDEX conversations_created_at_idx ON conversations (created_at);
CREATE INDEX conversations_status_created_at_idx ON conversations (status, created_at);

CREATE TABLE handoffs (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL UNIQUE REFERENCES conversations (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  note_redacted   text,
  -- not_configured | delivered | failed: <reason>
  delivery_status text NOT NULL,
  delivered_at    timestamptz
);

CREATE INDEX handoffs_created_at_idx ON handoffs (created_at);

CREATE TABLE demo_requests (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash text NOT NULL,
  ts      timestamptz NOT NULL
);

CREATE INDEX demo_requests_ip_hash_ts_idx ON demo_requests (ip_hash, ts);
CREATE INDEX demo_requests_ts_idx ON demo_requests (ts);
