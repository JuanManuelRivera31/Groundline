# CLAUDE.md — Groundline (working name)

Groundline is a reusable AI support-agent kit. It answers customer questions **only** from a company's documentation, cites the source of every claim, says "I don't know" and offers a human hand-off when the evidence is insufficient, and ships with a measured accuracy report. It is the engine of a freelance service: each client gets their own deployment. It is not a multi-tenant SaaS.

## Non-negotiable rules

1. **Zero cost.** Use only the Gemini free tier, with no billing. Use no service that requires a card. If something needs payment or a card, stop and ask.
2. **Privacy.** Never send personal data to the Gemini free tier: Google may use that content to improve its products. Only public documentation is sent today.
3. **Secrets.** `GEMINI_API_KEY` lives only in `.env`. `.gitignore` covers `.env` and `data/`. Never print, log or commit keys. `.env.example` has no values.
4. **English only** for every repo artifact: code, comments, README, ADRs, commits.
5. **Offline tests.** Gemini is faked; `pnpm test` never calls the real API. Tests replace the global `fetch` with a rejecting stub.
6. **Git.** Make small commits using Conventional Commits. A normal `git push` to `origin` (`main`) is allowed when a block of work closes green: `pnpm lint`, `pnpm typecheck` and `pnpm test` pass, and `git status` shows neither `.env` nor `data/`. Force-push, `reset --hard` and deleting branches remain forbidden.
7. **One short ADR per architecture decision**, in `docs/adr/`.
8. **Verify, don't recall.** Check versions, model names and APIs against official docs, and cite the URL in the ADR.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install workspace dependencies |
| `pnpm lint` | ESLint (type-aware) |
| `pnpm typecheck` | `tsc --noEmit` for root and every package |
| `pnpm test` | Vitest unit tests (offline) |
| `pnpm build` | Emit `dist/` for libraries, typecheck apps |
| `pnpm db:up` / `pnpm db:down` | Start/stop local Postgres + pgvector (Docker, port `PG_PORT`, default 54329) |
| `pnpm db:migrate` | Apply pending SQL migrations (idempotent) |
| `pnpm ingest --source plausible [--dry-run]` | Clone the pinned corpus, chunk, embed (cache-first), upsert, delete stale rows |
| `pnpm search:debug "<question>"` | Top 5 vector and top 5 full-text hits, shown separately |
| `pnpm chunks:stats --source plausible` | Chunk quality report from the local checkout (no network) |

Node 26 runs the TypeScript sources directly (type stripping), so there is no compile step for the CLIs.

## Structure

```
packages/core     Runtime-agnostic logic (Node + Workers): markdown/MDX cleaning, chunking,
                  Docusaurus URL mapping, Gemini client, cache keys, rate limiter, config.
                  No node:* imports, no process/Buffer (lint-enforced).
packages/db       SQL migrations, Db interface, Node adapter (pg). Workers adapter: deployment session.
apps/ingest       Node-only CLIs: ingest, search:debug, db:migrate, chunks:stats.
docs/adr          Architecture decision records.
data/             Gitignored: cloned corpora.
```

Later sessions add `apps/api` (Hono on Workers), `apps/widget`, `apps/admin` and `packages/evals`.

## Conventions

- Strict TypeScript and erasable syntax only (no enums, namespaces or parameter properties). Relative imports use `.ts` extensions.
- Inject I/O (fetch, clock, sleep, random, Db) so logic stays testable offline.
- Every Gemini HTTP call is recorded in `api_usage`. A batch of N texts counts as N requests until Google's accounting is confirmed.
- Changing `EMBEDDING_DIMS` requires a new migration. Never edit an applied migration; add a new one.

## Definition of done

- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
- New behaviour has unit tests, and new decisions have an ADR.
- For ingestion changes, the real ingest completes and a second run makes 0 API requests.
- Changes are committed in small Conventional Commits and pushed normally to `origin/main` once green (never force).

## Final session report format

Deliver one block containing:

1. Repo tree (2 levels).
2. ADRs created, each with its decision in one line.
3. Summarized output of lint, typecheck and test.
4. Ingestion stats for both runs (documents, chunks, tokens, requests, cache hits, duration).
5. `search:debug` results for the agreed questions.
6. Chunk quality: total; token min/median/p95/max; count under 60 tokens; top 5 documents by chunk count; 3 random full chunks (heading_path, URL#anchor, content).
7. Decisions taken autonomously.
8. Risks and open questions, including observed rate-limit headers and 429s.
9. `git log --oneline`.
