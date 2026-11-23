# ADR-0003: Gemini embeddings on the free tier, with cache and client-side limiter

- Status: Accepted
- Date: 2026-11-22

## Context

Hard constraints: zero cost (Gemini free tier only, no billing), and no personal data sent to the free tier, because Google may use free-tier content to improve its products. In S1 only public documentation is embedded.

## Decision

- **Model: `gemini-embedding-001`**, configurable with `EMBEDDING_MODEL`.
  - It is stable and free on the free tier.
  - It supports `taskType`: `RETRIEVAL_DOCUMENT` for chunks and `RETRIEVAL_QUERY` for questions.
  - In a batch it returns one vector per text.
  - `gemini-embedding-2` was considered. It is also stable and free, but it does not accept `taskType` (it uses text prefixes instead) and it aggregates array inputs into a single vector. It needs a different request builder, so it stays an option for later.
- **Dimensions: 768** (`EMBEDDING_DIMS`) via `outputDimensionality`. That is one of the recommended sizes (768/1536/3072) and well under HNSW's 2,000 limit.
  - The docs say gemini-embedding-001 vectors at sizes other than 3072 must be normalized by the client, so every vector is **L2-normalized**.
- **Endpoint**: REST `POST /v1beta/models/{model}:batchEmbedContents`, called through `fetch`. The key goes only in the `x-goog-api-key` header and is redacted from errors.
  - The docs disagree on where `taskType`/`outputDimensionality` belong. The gemini-embedding-001 REST examples put them next to `content`; the API reference documents them inside `embedContentConfig`.
  - We send the top-level form by default. `GEMINI_EMBED_REQUEST_SHAPE=config` switches to the nested form. The client verifies the returned dimension, so an ignored `outputDimensionality` fails loudly.
  - The `title` parameter is **never sent**, because the heading path is already in the text. If it ever is sent, it is part of the cache key.
- **Cache**: `embedding_cache` is keyed by `sha256(["v1", model, dimensions, taskType, title|null, text])`.
  - `taskType` is included because it changes the vector.
  - Each batch is written to the cache as soon as it returns, so a crashed or over-quota run resumes without spending quota twice. A second ingest of unchanged docs makes **0** API calls.
- **Limiter** (client-side):
  - RPM and TPM use a sliding 60-second window; RPD is a calendar day that resets at **midnight Pacific time**, as the docs state.
  - Limits come from `.env` (`GEMINI_EMBED_RPM/TPM/RPD`). The conservative defaults are 60 / 20,000 / 800, because the docs do not publish free-tier numbers for embedding models; they point to AI Studio.
  - Until we know how Google counts `batchEmbedContents`, **a batch of N texts counts as N requests** for RPM and RPD (worst case). The batch size (`EMBEDDING_BATCH_SIZE`, default 20) therefore cannot exceed RPM. Batches are also capped at half the TPM budget.
  - Tokens are estimated as ~4 characters per token. The limiter applies a 1.2 safety factor.
  - The RPD counter starts from `api_usage` (every Gemini call of every kind since the last Pacific midnight). A run that would exceed the remaining daily quota stops before its first call.
- **Retries**: 429, 408 and 5xx get exponential backoff with equal jitter (base 2 s, cap 120 s, `GEMINI_MAX_RETRIES` default 6). The delay is never shorter than the server's `RetryInfo.retryDelay` or `Retry-After`.
  - Every attempt, including failed ones, is recorded in `api_usage` with its HTTP status.
  - Rate-limit response headers are surfaced in the ingest summary.

## Consequences

- A model switch is a config change plus a re-ingest. The new vectors are cached under new keys, and `ingest_runs` records the model and dimensions of every run.
- Worst-case quota accounting may make runs slower than strictly necessary. We will revisit it once real 429s and headers have been observed.

## Sources

- Embeddings guide (models, dimensions, normalization, task types, batching behaviour): https://aistudio.google.com/docs/embeddings
- API reference (`batchEmbedContents`, `EmbedContentConfig`, `x-goog-api-key`): https://aistudio.google.com/api-reference/embeddings and https://aistudio.google.com/api-reference/embeddings/batch-embed-contents
- Rate limits (RPD resets at midnight Pacific; per-model limits in AI Studio): https://aistudio.google.com/docs/rate-limits
- Pricing and data use on the free tier ("Content used to improve our products"): https://aistudio.google.com/docs/pricing
