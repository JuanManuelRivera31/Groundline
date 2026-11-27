# ADR-0012: Demo API and its protections

- Status: Accepted
- Date: 2026-11-26

## Context

The answer engine is frozen and measured (prompt v4, validator, floor 0.600, vector retrieval 20 → 6, model chain with a 3 s hedge, 7.5 s budget; `evals/plausible/REPORT.md`). Until now it only ran from the CLI.

The public demo needs an HTTP API that anyone can call. It runs on the Gemini free tier, so the API must:
- protect a small shared quota;
- keep personal data away from Google (CLAUDE.md rule 2);
- respect the free tier's terms;
- leave the engine's behaviour exactly as measured.

## Decision

### The engine is wrapped, not changed
- `apps/api` calls `answerQuestion` in **live mode**, through the same `createAnswerRuntime` wiring that `pnpm ask` uses.
- That wiring moved to `@groundline/evals/runtime` with no Node APIs. Its `sleep` now uses the global `setTimeout`, which behaves the same. A test-only `clients` option injects fakes.
- `packages/core/src/answer/**` is untouched.
- The API changes only the engine's **inputs**: the question is redacted first, and the daily cap lowers each model's RPD.

### Endpoints (Hono)

| Endpoint | Behaviour |
| --- | --- |
| `POST /v1/ask {question, lang?}` | `{conversation_id, status, answer, sources[{n,title,url,quotes}], articles[{title,url}], handoff_offered, lang}`. `answer` keeps the engine's renumbered `[n]` markers; `sources[n]` matches them. `status` is one of the engine's five (`answered`, `insufficient`, `handoff`, `declined`, `unavailable`) or one of two API statuses (`articles_only`, `region_blocked`). |
| `POST /v1/handoff {conversation_id, note?}` | Records one case per conversation (idempotent). It never asks for contact data. `note` is optional, ≤ 500 characters and redacted. Answers 201 when created, 200 when the case already existed, 404 for an unknown conversation. |
| `GET /v1/health` | `{status, db}`; 503 when the database does not answer. |
| `GET /v1/admin/conversations[?status&before&limit]`, `/conversations/:id`, `/handoffs`, `/gaps?days`, `/daily?days` | Read-only, with `Authorization: Bearer ADMIN_TOKEN` (≥ 32 characters, compared in constant time). Without a token configured the admin API answers 404. |

- `lang` (`en`, `es` or a subtag such as `es-MX`) chooses only the API's own fixed messages. The engine still detects the answer language from the question.
- Errors are JSON, `{error: {code, message}}`. They never echo the request.
- Bodies are limited to 8 KB and must be valid UTF-8 (`invalid_encoding`). In the manual test a CP1252 shell argument reached the store garbled, so decoding is now fatal.

### Request order for `/v1/ask`
1. Body limit, JSON, UTF-8 and shape checks. Then the question must be non-empty and **≤ 500 code points** (`MAX_QUESTION_CHARS`). Requests rejected here do not count against the limit.
2. Origin: a request whose `Origin` is not in `CORS_ORIGINS` gets 403. CORS headers are sent only to those origins. Requests without `Origin` (servers, curl) pass and are held by the per-IP limit.
3. **Per-IP limit**: **3 per minute** (sliding 60 s) and **15 per UTC day** (`RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_DAY`).
   - Over either limit the answer is 429 with `Retry-After` and an en/es message.
   - Rejected requests are not recorded, so retrying does not extend the block.
4. **Regional block** (below).
5. **Daily AI budget** (below).
6. **Redaction**, then the engine.
7. The conversation row is written **after** the response, through `waitUntil` on Workers. Its id is a UUID generated before the engine runs, so the write adds no time to the 8 s target.

### IP privacy
- `salt = HMAC-SHA256(IP_HASH_SECRET, UTC day)` and `ip_hash = HMAC-SHA256(salt, ip)`. Only `ip_hash` and a timestamp go into `demo_requests`.
- The IP never reaches the database or the logs. Hashes from different days cannot be linked without the secret.
- `IP_HASH_SECRET` is required on Workers. On Node it falls back to a random per-process key, with a warning.
- Counting runs in one transaction under `pg_advisory_xact_lock(hashtext(ip_hash))`. Concurrent requests from one IP are serialized; the test shows exactly 3 of 5 parallel requests pass.
  - The lock is transaction-level, so it works behind transaction-mode poolers (PgBouncer, Hyperdrive).
- Rate-limit rows older than 2 days are deleted.

### Regional block
- The Gemini API Additional Terms, section "Use Restrictions", say: *"You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom."* The demo uses the free tier, so requests from there never reach Gemini, the embedding call included.
- **Blocked by default**:
  - the 27 EU states, plus IS, LI and NO;
  - CH and GB;
  - as a precaution, codes that geolocation may report separately: AX, GF, GP, MQ, RE, YT and MF, and also GG, JE, IM and GI.
  - `BLOCKED_COUNTRIES` replaces the list per deployment.
- **Country source.** On Workers it comes from `request.cf.country`. A missing value, a value that is not two letters, or `XX` is blocked: the check fails closed.
  - On Node the country is `DEV_COUNTRY`, and an unknown country is allowed, because local requests carry none.
  - The header `x-groundline-dev-country` is honoured only with `DEV_COUNTRY_HEADER=1`, for manual tests.
- **Response**: a fixed en/es message. The row keeps the status and the country code, **without the question**.
- The same terms also say:
  - users must be 18 or older, and services likely to be accessed by under-18s are not allowed;
  - the API is for professional or business use;
  - no sensitive, confidential or personal information should go to Unpaid Services.
  The B2B support demo fits these terms. The widget (S4b) should restate the last point to visitors.

### Daily AI budget
- **`DEMO_DAILY_GEN_CAP` = 150** generation requests per chain model per Pacific day. It never exceeds the configured RPD (200 by default). The headroom keeps 50 a day free for evals and manual checks.
- It is counted from `api_usage`, the same table and Pacific-midnight reset as the client-side limiter. Hedged and failed attempts count too, as in ADR-0009.
- The cap is passed to the engine as each model's RPD. A spent model is then skipped by the engine's existing `quota_local` check, and the next one answers.
- When **every** chain model is spent, the status is **`articles_only`**, with no Gemini call at all:
  - a fixed message ("the demo has reached its daily limit of AI answers") plus up to 3 articles and a human offer;
  - the articles come from vector search when the query embedding is cached, and from full-text search otherwise.
- The query-embedding model keeps its own client RPD (`GEMINI_EMBED_RPD`). When that is spent, the engine's existing fallback applies: full-text articles with status `unavailable`.

### Personal data redaction (`packages/core/src/privacy/redact.ts`)
- **What becomes `[redacted]`**, before the model, before the embedding and before storage:
  - email addresses;
  - IPv4 and IPv6 addresses, full and compressed;
  - **card-shaped numbers**: 13–19 digits with optional single spaces or dashes. Shape only, with no Luhn check, so a 13-digit millisecond timestamp is redacted too;
  - **phone numbers**: 9–15 digits with an optional `+` and spaces, dashes, dots or parentheses. A bare Spanish mobile such as `612345678` counts.
- **What is left alone:**
  - dates, versions, ports, times, decimals and numbers with thousands separators;
  - digits inside URLs. Within a URL only emails and IP addresses are redacted, so path segments and query values keep working.
- The hand-off note is redacted the same way.
- The tests cover English and Spanish, positives and negatives.
- Redaction is pattern-based: names, street addresses or IDs in free text are not detected. The demo tells visitors not to share personal data, and S4b's widget repeats it.

### Logs
- The logger accepts only an allow-list of fields with primitive values:
  - ids, status, HTTP status, latency, country code, answering model and the number of redacted spans;
  - error class names, plus the SQLSTATE code for Postgres errors.
- The question, the note, the answer, the IP, error messages and the request body cannot be logged.
- A test sends PII and checks that none of it appears in the logs. A forced Postgres error whose message contains an email shows that neither the 500 response nor the log contains it.
- The injection defences stay in the engine (ADR-0009). This layer only guarantees that the user's text is never logged and never stored unredacted.

### Conversations and retention
- **`conversations`** (migration 0003) stores:
  - the redacted question, status, answer, cited sources and articles;
  - `handoff_offered`, the answering model, `floor_hit`, `hedged`;
  - the nearest document and the max similarity;
  - latency, tokens and equivalent cost;
  - the country code and the engine's error code.
  There is **no IP column**.
- **`handoffs`** stores one row per conversation (`UNIQUE`, `ON DELETE CASCADE`): the redacted note, `delivery_status` (`not_configured`, `pending`, `delivered`, `failed: …`) and `delivered_at`.
- **Retention: 30 days** (`RETENTION_DAYS`). A daily Workers Cron Trigger (`0 3 * * *`) deletes older conversations and their cases, and rate-limit events older than 2 days.
  - The Free plan allows 5 Cron Triggers per account (ADR-0013), so cron replaces cleanup on write.
  - On Node the same purge runs at start-up and every 24 h.

### Hand-off delivery
- In the demo, `HANDOFF_WEBHOOK_URL` is unset. The case is recorded, nobody is notified, and the reply says so.
- In a client deployment, the case is POSTed to `HANDOFF_WEBHOOK_URL`:
  - the URL must be https; plain http is allowed only for localhost;
  - `HANDOFF_WEBHOOK_FORMAT=json` sends the case object (`type: groundline.handoff`, ids, timestamp, language, bot status, redacted question, answer, source URLs, redacted note);
  - `slack` sends a single `{text}` for Slack incoming webhooks. Email goes through any webhook-to-email relay.
- With `HANDOFF_WEBHOOK_SECRET`, the request carries `X-Groundline-Timestamp` and `X-Groundline-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`, so the receiver can reject forgeries and replays.
- There is one attempt, with a 5 s timeout (`HANDOFF_WEBHOOK_TIMEOUT_MS`). The result goes into `delivery_status`. A failed delivery still records the case.
- It is tested against a fake receiver (a Hono app reached through an injected `fetch`): json, slack, signature, HTTP 500 and timeout.

### Admin views
- **Gaps.** `insufficient` questions are grouped by their nearest retrieved document (URL without anchor), which is the topic the docs are missing.
  - Inside a group, questions are deduplicated by normalized text (NFKC, lower case, collapsed whitespace, no leading or trailing ¿¡?!.), with count, last seen and best similarity.
  - The grouping is done in TypeScript over at most 2,000 rows.
- **Daily**, per UTC day, aggregated in SQL to save Worker CPU:
  - conversations by status and their latency p50/p95;
  - tokens and equivalent cost;
  - availability = 1 − `unavailable` / model-eligible conversations, where floor hits, region blocks and articles-only do not count as eligible;
  - `api_usage` calls, requests and failures per model.

## Consequences

- The measured quality numbers still describe the API's answers: same engine, same live mode. The only new input is the redacted question.
- Part of the abuse surface is spread across IPs: 15 questions × many IPs is limited only by the daily cap. When the cap is spent the demo degrades to articles, not errors.
- The cap and the per-IP limits are per deployment (environment variables). A paying client's deployment would raise or remove them.
- At UTC midnight the salt changes, so one IP can send up to 3 + 3 questions in the minute around it. The daily count also restarts then, as intended.

## Sources

- Gemini API Additional Terms of Service (effective 2026-03-23, read 2026-11-26): EEA/CH/UK paid-only restriction, Unpaid Services data use, no personal information, age 18+, professional use: https://ai.google.dev/gemini-api/terms (redirects to https://aistudio.google.com/docs/terms)
- Gemini API available regions (EEA, CH and UK listed as supported, read 2026-11-26): https://ai.google.dev/gemini-api/docs/available-regions
- Cloudflare `request.cf.country` ("The two-letter country code in the request", `string | null`, read 2026-11-26): https://developers.cloudflare.com/workers/runtime-apis/request/
- Cron Triggers on the Free plan (5 per account) and the scheduled handler: https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/workers/configuration/cron-triggers/
- PostgreSQL advisory locks (`pg_advisory_xact_lock`, held until the transaction ends, read 2026-11-26): https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS
- Hono CORS and body-limit middleware (read 2026-11-26): https://hono.dev/docs/middleware/builtin/cors · https://hono.dev/docs/middleware/builtin/body-limit. The CORS page documents an `origin` callback but not what returning `null` does. A test confirms that no `Access-Control-Allow-Origin` header is sent then.
- Slack incoming webhooks (a JSON body with `text`, read 2026-11-26): https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
