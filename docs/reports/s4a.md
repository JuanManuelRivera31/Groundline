# Session S4a report: demo API, protections and the Workers + Neon adapter

- Date: 2026-11-26 (US evening; UTC 2026-11-27 early hours).
- Scope: `apps/api` (Hono) for Node and Cloudflare Workers, the demo protections, conversation logging, hand-off, a read-only admin API, and a Workers database adapter tested against the local Postgres.
- Out of scope, as agreed: the widget and the admin panel (S4b), and the real deployment (S4c).
- No account was created and nothing was deployed.
- **The engine is unchanged.** No change to prompt v4, the validator, FLOOR 0.600, retrieval, the chain, the hedge or the 7.5 s budget.
  - Its Node wiring moved to a Node-free module (`@groundline/evals/runtime`) with identical behaviour. Its `sleep` now uses the global `setTimeout`.
  - A test-only option injects fakes.
  - `packages/core/src/answer/**` has no diff this session.

## 1. Repo tree (2 levels)

```
apps/
  api/            Hono demo API (src/app.ts, src/node/server.ts, src/worker.ts, wrangler.toml, test/)
  ingest/         Node CLIs
packages/
  core/           runtime-agnostic logic (+ privacy/redact.ts)
  db/             migrations (+0003_api), PgQueries, PgDb (node), ClientDb (workers)
  evals/          eval tooling (+ runtime.ts, runtime-io.ts: Node-free engine wiring)
docs/
  adr/            0001–0013
  reports/        s1, s2, s3, s5a, s5b, s5c, s6, s4a
evals/
  judge/  plausible/  runs/
scripts/
  test-db.ts      pnpm test:db runner (local Postgres only)
CLAUDE.md  LICENSE  NOTICE  README.md  docker-compose.yml  eslint.config.mjs  package.json
pnpm-lock.yaml  pnpm-workspace.yaml  tsconfig*.json  vitest.config.ts  vitest.setup.ts
data/             gitignored (corpora, eval work, worker-build, local logs)
```

## 2. ADRs created

- **ADR-0012, demo API and protections.**
  - The engine is wrapped, not changed.
  - Endpoints: `/v1/ask`, `/v1/handoff`, `/v1/health`, `/v1/admin/*`.
  - Protections: a per-IP limit (3/min, 15/UTC day) on a daily-salted HMAC of the IP; 500 characters; a per-model daily cap of 150 with an articles-only fallback; PII redaction before the model and before storage; the EEA/CH/UK block, fail-closed on Workers.
  - Logs carry no customer text. Retention is 30 days through a daily cron. The hand-off webhook is optionally HMAC-signed.
- **ADR-0013, Workers (Free) + Neon (Free).**
  - Hono 4.13.22 and one `createApp` for both runtimes.
  - `ClientDb`, one `pg.Client` per request, over the shared SQL.
  - wrangler 4.168.0 for the local bundle and `wrangler dev`.
  - In S4c: Hyperdrive with `--caching-disabled` in front of Neon's direct `sslmode=require` string.
  - The Free limits, verified with their URLs.
  - Main risk: 10 ms of CPU per request.

## 3. Lint, typecheck, tests

| Check | Result |
| --- | --- |
| `pnpm lint` | 0 problems |
| `pnpm typecheck` | root + 5 packages, 0 errors |
| `pnpm test` (offline) | **286 passed, 5 skipped** (30 files; the 2 Postgres files are skipped without `PG_TEST_URL`) |
| `pnpm test:db` (local Docker Postgres, temporary schemas) | **5 passed** (2 files) |
| `pnpm build:worker` (`wrangler deploy --dry-run`) | 491.7 KiB / 115.5 KiB gzip |
| gitleaks v8.30.1 (full history) | 139 commits, no leaks |

The new tests:
- **`packages/core/test/redact.test.ts`** (10 tests): redaction in English and Spanish, positives and negatives (dates, versions, ports, amounts, times, `data-domain`, URLs).
- **`apps/api/test/ask.test.ts`** (10 tests), the ask flow:
  - a cited answer with numbered sources, a floor hit with no model call, and the chain fallback to `unavailable` with articles;
  - validation: JSON, the 500-code-point limit (501 → 400; 500 emoji pass), invalid UTF-8, the 8 KB body limit;
  - `lang`, health (ok and 503), a JSON 404, and CORS allowed, denied and 403.
- **`apps/api/test/protections.test.ts`** (15 tests), the protections:
  - the per-minute limit with `Retry-After`, the per-day limit and its reset at UTC midnight, and that the IP is never stored and its hash changes daily;
  - the region block for DE/ES/NO/IS/LI/CH/GB with no model or embedding call and no question stored, in Spanish too; fail-closed for a missing country, `XX` or `T1` on Workers; a custom list;
  - the cap: a model is skipped at 150, articles-only makes zero Gemini calls, a cached-vector variant, and the cap never exceeds RPD;
  - PII: redacted before the model, the embedding and storage, and no PII in logs or the 500 response.
- **`apps/api/test/handoff-admin.test.ts`** (13 tests), hand-off, admin and retention:
  - hand-off without contact data, idempotent, validation and 404;
  - the webhook against a fake receiver: signed json, slack `{text}`, HTTP 500 and a timeout recorded; an https-only URL;
  - admin: 401 without a token or with a bad one, 404 when not configured, a list with a filter and pagination, the detail view, hand-offs, gaps grouping and the daily view;
  - retention: cases cascade.
- **`apps/api/test/worker.test.ts`** (4 tests), the Workers entry point:
  - a config error answers 500 without detail;
  - a per-request `ClientDb` with health answering 503 when the database is down;
  - validation before the database;
  - the scheduled handler logs a failure instead of throwing.
- **`packages/db/test/pg-adapters.test.ts`** (3 tests, `test:db`), the adapters on Postgres:
  - `ClientDb` connects lazily and closes; shared SQL for search, cache and usage;
  - the rate limit, including 5 parallel clients of which exactly 3 pass;
  - conversations, hand-offs, gaps, daily stats and purge.
- **`apps/api/test/pg-api.test.ts`** (2 tests, `test:db`): the full API on a per-request `ClientDb` with the fake model, through ask, hand-off and admin; the 4th question in a minute gets 429; FR is blocked with no model call.

## 4. Ingestion stats

Not applicable: ingestion and the corpus are unchanged. `pnpm db:migrate` applied only `0003_api`.

## 5. `search:debug`

Not applicable: retrieval is unchanged and frozen.

## 6. Chunk quality

Not applicable: chunking is unchanged (789 chunks).

## Endpoints

| Endpoint | Returns |
| --- | --- |
| `POST /v1/ask {question, lang?}` | `{conversation_id, status, answer, sources[{n,title,url,quotes}], articles[{title,url}], handoff_offered, lang}`. `status`: `answered`, `insufficient`, `handoff`, `declined`, `unavailable`, `articles_only` or `region_blocked`. Errors: 400 (`invalid_json`, `invalid_encoding`, `invalid_request`, `empty_question`, `question_too_long`), 403 `origin_not_allowed`, 413 `body_too_large`, 429 `rate_limited` with `Retry-After`, 500 `internal`. |
| `POST /v1/handoff {conversation_id, note?}` | 201 (created) or 200 (already recorded), `{handoff_id, conversation_id, notified, message}`; 400 or 404 otherwise. |
| `GET /v1/health` | `{status:"ok", db:"ok"}`, or 503 `{status:"degraded", db:"error"}` |
| `GET /v1/admin/conversations?status&before&limit≤100`, `/v1/admin/conversations/:id`, `/v1/admin/handoffs?before&limit`, `/v1/admin/gaps?days≤RETENTION_DAYS`, `/v1/admin/daily?days≤90` | Read-only views with `Authorization: Bearer ADMIN_TOKEN`; 401 with a bad token, 404 when no token is configured |

## Protections and their values

| Protection | Value | Where |
| --- | --- | --- |
| Per-IP limit | **3 per 60 s**, **15 per UTC day**. Counted on `HMAC(HMAC(IP_HASH_SECRET, day), ip)`; rejected requests are not recorded. | `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_DAY` |
| Question length | **≤ 500** code points; body ≤ 8 KB; valid UTF-8 | `MAX_QUESTION_CHARS` |
| Daily AI budget | **150** generation requests per chain model per Pacific day (≤ RPD 200). A spent model is skipped; when all are spent, `articles_only` with 0 Gemini calls. | `DEMO_DAILY_GEN_CAP` |
| PII redaction | Emails, IPv4/IPv6, card-shaped numbers (13–19 digits), phones (9–15 digits) become `[redacted]`, before the model, the embedding and storage, and in the hand-off note | `packages/core/src/privacy/redact.ts` |
| Regional block | EU 27 + IS, LI, NO + CH, GB, plus AX, GF, GP, MQ, RE, YT, MF, GG, JE, IM, GI. Fixed message, no Gemini call, no question stored. Workers fails closed on an unknown country. | `BLOCKED_COUNTRIES`, `DEV_COUNTRY`, `DEV_COUNTRY_HEADER` (Node) |
| CORS | Configured origins only; a foreign `Origin` gets 403 | `CORS_ORIGINS` |
| Logs | Allow-listed fields only: ids, status, latency, country, model, redacted-span count, error class/SQLSTATE | `apps/api/src/logger.ts` |
| Retention | **30 days**, through a daily cron `0 3 * * *` on Workers (and at start-up plus every 24 h on Node); rate-limit events after 2 days | `RETENTION_DAYS` |
| Hand-off | No contact data asked; demo: recorded only. Real deployment: `HANDOFF_WEBHOOK_URL` (https), `json` or `slack`, optional HMAC signature, 5 s timeout. | `HANDOFF_WEBHOOK_*` |
| Admin | Bearer `ADMIN_TOKEN` of ≥ 32 characters, compared in constant time | `ADMIN_TOKEN` |

## Workers and Neon limits verified (2026-11-26)

- **Workers Free:**
  - 100,000 requests/day;
  - **10 ms CPU** per request and per cron;
  - 128 MB of memory;
  - 50 subrequests;
  - 6 simultaneous outgoing connections;
  - 64 MiB uncompressed size;
  - 64 variables;
  - unlimited HTTP wall time (15 min for cron);
  - **5 Cron Triggers per account**;
  - nodejs_compat on by default from compatibility date 2026-08-04.
- **Hyperdrive:**
  - included in Free: 100,000 queries/day, ~20 origin connections;
  - **query caching on by default (60 s), not invalidated on writes**, so it must be created with `--caching-disabled`.
- **Neon Free:**
  - no card;
  - 100 CU-hours per project per month;
  - 1 GB per project;
  - 5 GB egress per month;
  - scale to zero after 5 min (fixed), reactivation "within a few hundred milliseconds";
  - Postgres 18 default, pgvector included;
  - PgBouncer transaction mode, so no session advisory locks: migrations use the direct connection.
- **Gemini terms:**
  - *"You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom"*;
  - no personal information to Unpaid Services;
  - 18+ only;
  - professional use.
- URLs are in ADR-0012 and ADR-0013.

## Definition of done

- `pnpm lint`, `pnpm typecheck` and `pnpm test` are green (§3).
- **`pnpm dev:api` against the Docker Postgres**, with the real Gemini free tier. It used **2 real questions**, i.e. 2 query embeddings and 2 generations. Today's quota beforehand: 3.5-flash-lite 144, 3.1-flash-lite 130, embedding 150.

  | Request | Result |
  | --- | --- |
  | `GET /v1/health` | `{"status":"ok","db":"ok"}` |
  | `POST /v1/ask` "How do I exclude my own visits from my stats?" | **answered** by gemini-3.5-flash-lite in **2.43 s** (HTTP total). 3 numbered sources (`excluding-localstorage#excluding-your-own-visits`, `excluding#exclude-visits-by-ip-address`, `excluding`); every sentence and list item cited; code block kept. |
  | `POST /v1/ask` Spanish question with an email address | **answered** in **2.13 s**. The email was stored as `[redacted]` (`redacted_spans: 1` in the log), 2 sources, cost $0.0015 equivalent. See the encoding note below. |
  | `POST /v1/ask` with `x-groundline-dev-country: DE` | `region_blocked`, 22 ms, no Gemini call |
  | `POST /v1/ask` with 501 characters | 400 `question_too_long` |
  | 4th question within the minute | 429 `rate_limited`, `Retry-After: 55` |
  | `POST /v1/handoff` | 201, `notified: false`, the Spanish demo message |
  | Admin without a token, then with it | 401; then the conversation detail, `daily` (availability, p50 2,122 ms, tokens, cost, `api_usage` per model) and `gaps` (empty) |

  - Both Gemini calls returned HTTP 200: generation in 1,901 and 1,730 ms, embedding in 420 and 269 ms. There was no 429 and no 503.
  - **Encoding note.** The Spanish question reached the API garbled (`�C�mo … est�`). A local echo server showed that curl in Git Bash sent the argument as CP1252 (`bf 43 f3…`), not UTF-8 (`c2 bf 43 c3 b3…`). The API is now stricter: a body that is not valid UTF-8 gets 400 `invalid_encoding`, with a test.
  - The model answered that garbled question in English. It was not re-asked, to stay within the agreed 1–2 real requests. The answer language for clean Spanish input is unchanged engine behaviour, covered by the eval prompts.
- **Workers bundle in local workerd** (`wrangler dev --local`, no login, no Gemini key passed):
  - `/v1/health` gave `ok` through `pg` over `cloudflare:sockets` to the Docker Postgres;
  - `/v1/ask` gave `unavailable` with 3 full-text articles, which is expected without a key;
  - the 501-character question got 400;
  - the cron endpoint ran the retention purge;
  - `request.cf.country` was populated locally (`CO`).
- **Commits and push:** 9 Conventional Commits, without a co-author trailer, pushed to `origin/main`.

## 7. Decisions taken autonomously (all in the approved plan unless noted)

1. The engine wiring moved to `@groundline/evals/runtime`, with no behaviour change and a test-only `clients` option.
2. All SQL is shared in `PgQueries`; `PgDb` (pool) and `ClientDb` (one client per request) differ only in lifecycle. `ClientDb` serializes statements so a transaction never interleaves.
3. A request with no country is blocked on Workers (fail-closed). The block list includes the codes geolocation may report separately.
4. A foreign `Origin` gets 403. Requests without `Origin` pass and are limited per IP.
5. Region-blocked conversations are stored without the question.
6. `articles_only` makes no Gemini call at all: it uses a cached query vector, or else full-text search.
7. Cards are detected by shape, without Luhn, as the conservative choice.
8. The conversation is written after the response (`waitUntil`).
9. Hyperdrive will be created with caching disabled.
10. **Not in the plan:**
    - invalid UTF-8 bodies are refused (`invalid_encoding`), after the manual test;
    - **Hono was pinned to 4.13.22**, not 4.13.23: pnpm's release-age policy flagged the same-day release, and the gate was not bypassed;
    - the `esbuild` and `workerd` build scripts were approved in `pnpm-workspace.yaml`, which wrangler needs;
    - `.wrangler/` was added to `.gitignore` and the ESLint ignores.
11. `pnpm test:db` refuses any database that is not on 127.0.0.1 or localhost, and works in temporary schemas so the dev data is never touched.
12. Rejected requests (400, 403, 429) do not count against the per-IP limit.

## 8. Risks and open questions

- **10 ms of CPU per request on Workers Free.** SCRAM authentication in `pg`, JSON and validation work, and parsing a cached 768-dimension vector all count. This can only be measured on the deployed Worker in S4c.
  - Fallbacks: Hyperdrive (already planned), then a lighter vector path, then Workers Paid, which needs a card and so your approval.
- **The minute window of the client-side RPM limiter lives in memory per isolate on Workers.** RPD is global, from `api_usage`. Bursts across many IPs could reach Google's per-minute limit; the engine then switches model or degrades to `unavailable`.
- **Distributed abuse.** Many IPs at 15 a day each are bounded only by the daily cap (150 per model). After that the demo answers with articles only, so the quota is protected but other visitors get no AI answers that day.
- **Redaction is pattern-based.** Names, street addresses or account IDs in free text are not detected. The widget (S4b) should tell visitors not to share personal data. Shape-only card detection also redacts 13–19 digit numbers such as millisecond timestamps.
- **Neon cold start.** After 5 idle minutes the first question pays a few hundred ms on top of the engine's 7.5 s budget. The 8 s target is measured at the engine, so S4c should re-measure end to end.
- **UTC midnight.** The salt rotates then, so one IP can send up to 3 + 3 questions in the minute around it.
- **Free-tier terms.** 18+ only and professional use. The demo is a B2B support bot, so this fits, but the S4b widget copy should say so.
- **Quota today, Pacific day.** gemini-3.5-flash-lite is at 146 of the 150 demo cap after the manual test, so the local demo would switch to the fallback model for the rest of the day.
- **Rate-limit headers and 429s.** Gemini returned no 429 and no 503 this session (2 generations, 2 embeddings, all HTTP 200). No new rate-limit headers were recorded.
- **Hand-off race.** On Workers the conversation row is written after the response, so a hand-off posted within a few milliseconds could arrive before the row exists and get 404. It is very unlikely with a human click.
- **Open for S4c:**
  - create the Neon project and the Hyperdrive configuration (`--caching-disabled`);
  - set the secrets (`GEMINI_API_KEY`, `IP_HASH_SECRET`, `ADMIN_TOKEN`);
  - run `pnpm db:migrate` against Neon over the direct connection, and ingest the corpus into Neon (cache-first);
  - set `CORS_ORIGINS` to the widget origin;
  - measure CPU time and end-to-end latency.

## 9. `git log --oneline` (this session)

```
af4c008 docs: ADR-0012 (demo API and protections) and ADR-0013 (Workers + Neon), env example, README and CLAUDE.md
b56e0d7 build(api): wrangler config, local Worker bundle and dev scripts
0eb531e fix(api): refuse request bodies that are not valid UTF-8
bd7df0c test: Postgres-backed tests for ClientDb, PgDb and the API (pnpm test:db)
122caaf feat(api): Hono demo API with protections, hand-off and read-only admin
f876581 feat(db): conversations, hand-offs and rate-limit events, shared SQL and a per-request ClientDb
535a9dd feat(core): redact emails, phones, card-shaped numbers and IPs
f5da35c refactor(evals): runtime-agnostic answer runtime wiring for the API
```

Plus the commit that adds this report.
