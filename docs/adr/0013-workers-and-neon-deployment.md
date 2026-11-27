# ADR-0013: Cloudflare Workers (Free) + Neon (Free) for the demo API

- Status: Accepted (deployment itself is S4c)
- Date: 2026-11-26

## Context

The demo must cost $0 and need no card (CLAUDE.md rule 1). ADR-0002 chose `pg` for both runtimes and deferred the Workers adapter: one `Client` per request, written and tested in the deployment session.

S4a builds and tests everything up to the deploy:
- the same Hono app on Node and Workers;
- a Workers database adapter tested against the local Postgres;
- a local Worker bundle.

No account is created and nothing is deployed.

## Decision

### Runtime and framework
- **Hono 4.13.22** (`hono`) and **@hono/node-server 2.1.11**. The same `createApp(deps)` serves:
  - Node, through `apps/api/src/node/server.ts` (`pnpm dev:api`);
  - Workers, through `apps/api/src/worker.ts`.
- **The entry points differ only in:**
  - the database adapter;
  - how they read the client IP and country;
  - how work is deferred: `ctx.waitUntil` on Workers, a tracked promise on Node.
- Everything else in `apps/api/src` is Node-free, and lint enforces it. So are `packages/core`, the shared SQL in `packages/db/src`, the Workers adapter and `@groundline/evals/runtime`.
- Hono 4.13.23 was published on the session day. pnpm's minimum-release-age policy wanted to exclude it, so the previous release was pinned instead of bypassing the supply-chain gate.
- **wrangler 4.168.0** is a devDependency. `pnpm build:worker` runs `wrangler deploy --dry-run --outdir data/worker-build`, and `pnpm dev:worker` runs `wrangler dev --local`. Neither needs a Cloudflare account.
- **pnpm build approvals.** `pnpm-workspace.yaml` allows the build scripts of `esbuild` and `workerd` (`allowBuilds`). Wrangler needs their platform binaries.
- **`wrangler.toml`:**
  - `compatibility_date = "2026-11-24"`. From 2026-08-04, `nodejs_compat` is on by default and the docs say to omit the flag, so there is no `compatibility_flags`;
  - `send_metrics = false`;
  - one cron, `0 3 * * *`, for retention (ADR-0012);
  - non-secret `[vars]` only. Secrets are set with `wrangler secret put` in S4c: `GEMINI_API_KEY`, `IP_HASH_SECRET`, `ADMIN_TOKEN`, `HANDOFF_WEBHOOK_SECRET`, and `DATABASE_URL` when Hyperdrive is not used.
- **Measured locally:**
  - the bundle is **491 KiB (115 KiB gzip)**, against a Free limit of 64 MiB uncompressed;
  - it imports only `cloudflare:sockets` and Node built-ins that nodejs_compat provides (pg's `net`, `tls`, `crypto`, `stream`…).
  - In local workerd (`wrangler dev --local`) against the Docker Postgres:
    - `/v1/health` answered `ok`;
    - `/v1/ask` answered, with the full-text fallback, because no Gemini key was passed;
    - the scheduled handler ran the retention purge.
  - So `pg` over `cloudflare:sockets` works end to end in workerd.

### Database adapter for Workers
- All SQL lives in one abstract class, `PgQueries` (`packages/db/src/pg-queries.ts`); the statement text was moved, not edited. On top of it:
  - **`PgDb`** (Node) runs it on a `pg.Pool`;
  - **`ClientDb`** (`@groundline/db/workers`) runs it on **one `pg.Client` per request**.
- **How `ClientDb` behaves:**
  - it connects lazily on the first query;
  - it serializes statements and transactions, so a transaction never interleaves with another query on the shared client;
  - it closes after the request's deferred work through `waitUntil`, and a request that never touched the database never connects.
- **Tests** (`pnpm test:db`): `ClientDb` and `PgDb` run against the local Docker Postgres, each test file in a temporary schema. They cover:
  - search, cache and usage;
  - rate limiting, including 5 parallel requests of which exactly 3 pass;
  - conversations, hand-offs, admin aggregates and purge;
  - the full API on a per-request `ClientDb`.
- **Connection.** `env.HYPERDRIVE.connectionString` is used when a Hyperdrive binding exists; otherwise `DATABASE_URL`.

### Neon + Hyperdrive (to set up in S4c)
- **Hyperdrive in front of Neon**, as both Cloudflare's and Neon's guides recommend, with `pg`. Neon's *direct* connection string (pooling off, `sslmode=require`) goes into Hyperdrive, because Hyperdrive pools connections itself.
- **Create it with `--caching-disabled`.** Hyperdrive caches read queries by default (`max_age` 60 s) and does not invalidate them on writes. With caching on, the daily-quota sums (`api_usage`), the per-IP counts and the admin views could be up to a minute stale. Those reads take their timestamps as parameters rather than calling `now()`, so they would be cacheable.
- **Fallback.** `DATABASE_URL` set to Neon's direct string with `sslmode=require`: one TLS connection and authentication per request, so higher latency.
- Migrations run from Node (`pnpm db:migrate` with `DATABASE_URL` pointing at Neon, direct connection) because they take a session advisory lock. Neon's pooler does not support those.

### Free-plan limits (read 2026-11-26)

| Service | Limit | Value | Effect on the demo |
| --- | --- | --- | --- |
| Workers Free | Requests | 100,000 / day (resets 00:00 UTC) | Far above the 15/IP and 150-per-model caps |
| | CPU time | **10 ms** per HTTP request and per Cron invocation | Main risk (below) |
| | Wall time | Unlimited for HTTP; 15 min for Cron | The 7.5 s engine budget is I/O wait, not CPU |
| | Memory | 128 MB per isolate | — |
| | Subrequests | 50 per invocation | A request makes ≤ 4 fetches (embedding, two hedged generations, webhook) |
| | Simultaneous outgoing connections | 6 (TCP `connect()` included) | At most 3 at once: the DB socket plus two hedged calls |
| | Worker size | 64 MiB uncompressed (no compressed limit) | 491 KiB |
| | Environment variables | 64 per Worker, 5 KB each | About 30 used |
| | Cron Triggers | **5 per account** | 1 used |
| Hyperdrive (Free) | Queries | 100,000 / day | About 15 queries per answered question |
| | Origin connections | ~20 per configuration | — |
| | Caching | On by default, 60 s, no invalidation on write | Must be disabled |
| Neon Free | Card | Not required | — |
| | Compute | 100 CU-hours per project per month; autoscaling up to 2 CU | Scale-to-zero keeps idle time free |
| | Storage | 1 GB per project | Conversations are small and kept 30 days |
| | Egress | 5 GB per project per month | — |
| | Scale to zero | After 5 min, fixed on Free; reactivation "within a few hundred milliseconds" | First question after idle is slower |
| | Postgres | 14–19, 18 default; pgvector included | Same major as local (ADR-0002) |
| | Over-limit | Compute suspended until the next period; data kept | The demo would answer 503 on health |

### Main risk: 10 ms of CPU on Workers Free
- The engine waits on I/O most of the time, which does not count. What does count:
  - JSON parsing, citation validation and redaction;
  - the HMAC hashes;
  - `pg` message parsing, and SCRAM-SHA-256 authentication (PBKDF2), unless Hyperdrive holds the authenticated connection;
  - parsing a cached 768-dimension query vector.
- S4a cannot measure Workers CPU locally. S4c measures it on the deployed Worker (CPU time per invocation in Cloudflare's metrics) before announcing the demo. If it goes over, the options in order are:
  - Hyperdrive, to avoid per-request authentication;
  - a cheaper vector exchange;
  - the Workers Paid plan, which needs a card and so the owner's approval (rule 1).

## Consequences

- The deploy in S4c only needs the accounts, the Hyperdrive configuration, the secrets and `wrangler deploy`. The code is already bundled and tested in workerd.
- The client-side RPM limiter in the engine lives in memory per isolate, so separate isolates don't share minute windows. The RPD (daily) count is global, because it is read from `api_usage`. The per-IP limit of 3 per minute bounds bursts per visitor.
- Wrangler and workerd add a large devDependency (binaries). They are used only for the local bundle and `wrangler dev`.

## Sources

- Workers limits (Free: 100,000 requests/day, 10 ms CPU, 128 MB, 50 subrequests, 6 connections, 64 MiB, 64 variables, 5 Cron Triggers), updated 2026-11-25: https://developers.cloudflare.com/workers/platform/limits/
- Workers pricing (Free: "10 milliseconds of CPU time per invocation"): https://developers.cloudflare.com/workers/platform/pricing/
- Cron Triggers (`[triggers] crons`, `scheduled(controller, env, ctx)`, UTC): https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Node.js compatibility (default from compatibility date 2026-08-04): https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- TCP sockets (`connect()`, port 25 and Cloudflare IPs blocked, Hyperdrive recommended for Postgres): https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- Wrangler configuration (`send_metrics`; `name`, `main` and `compatibility_date` required) and commands (`deploy --dry-run --outdir`, `dev --local`): https://developers.cloudflare.com/workers/wrangler/configuration/ · https://developers.cloudflare.com/workers/wrangler/commands/workers/
- Hyperdrive limits (Free: 100,000 queries/day, ~20 origin connections) and pricing (included in Free): https://developers.cloudflare.com/hyperdrive/platform/limits/ · https://developers.cloudflare.com/hyperdrive/platform/pricing/
- Hyperdrive query caching (on by default, `max_age` 60 s, `stale_while_revalidate` 15 s, no invalidation on write, `--caching-disabled`): https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
- Neon on Workers (Hyperdrive recommended, `pg`, direct string with pooling off, `pg` ≥ 8.16.3): https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/ · https://neon.com/docs/guides/cloudflare-workers
- Neon plans and pricing (Free: no card, 100 CU-hours/project, 1 GB, 5 GB egress, 10 branches, scale to zero after 5 min), read 2026-11-26: https://neon.com/docs/introduction/plans · https://neon.com/pricing
- Neon scale to zero (fixed on Free; reactivation in a few hundred ms): https://neon.com/docs/introduction/scale-to-zero
- Neon connection pooling (PgBouncer transaction mode; no session advisory locks; direct connection for migrations): https://neon.com/docs/connect/connection-pooling
- Neon compatibility (Postgres 14–19, 18 default): https://neon.com/docs/reference/compatibility
- Hono on Node (`@hono/node-server`, `serve`) and `getConnInfo`: https://hono.dev/docs/getting-started/nodejs · https://hono.dev/docs/helpers/conninfo
- Versions from the npm registry on 2026-11-26: `npm view hono`, `npm view @hono/node-server`, `npm view wrangler`
