-- 0002_api_usage_tokens: real token counts and latency for generation calls.
-- Nullable: embedding calls only have the estimate in est_tokens.

ALTER TABLE api_usage
  ADD COLUMN prompt_tokens   integer,
  ADD COLUMN output_tokens   integer,
  ADD COLUMN thoughts_tokens integer,
  ADD COLUMN latency_ms      integer;
