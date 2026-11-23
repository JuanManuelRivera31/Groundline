# ADR-0001: pnpm monorepo, strict TypeScript, Vitest, ESLint

- Status: Accepted
- Date: 2026-11-22

## Context

Groundline is a reusable support-agent kit that ships as one deployment per client. Its core logic has to run unchanged on Node (ingestion CLI, local development) and on Cloudflare Workers (the API, in a later session).

## Decision

- A **pnpm workspace** monorepo:
  - `packages/core`: pure logic (chunking, URL mapping, prompts, citation checks, "I don't know" policy, PII scrubbing, the embeddings client, the rate limiter). It uses no Node APIs, only web-standard globals (`fetch`, `crypto.subtle`, `TextEncoder`, `Intl`). It may depend only on pure-JS packages (`yaml`, `github-slugger`). Lint enforces this (`node:*` imports and `process`/`Buffer` are banned in `packages/core/src`), and core is typechecked against `lib: ES2024 + DOM` without `@types/node`.
  - `packages/db`: schema, plain SQL migrations, and the `Db` interface with a Node adapter (`pg`).
  - `apps/ingest`: the Node-only CLIs.
  - `apps/api`, `apps/widget`, `apps/admin` and `packages/evals` arrive in later sessions.
- **Node 26**, the Active LTS ("Lithium", LTS since 2026-10-28), pinned in `.nvmrc` and `engines`.
- **pnpm 12.21.0**, pinned through `packageManager`. Node ≥ 25 no longer bundles Corepack, so it is installed with `npm install -g corepack` followed by `corepack enable pnpm`.
- **TypeScript 6.0.3** in strict mode, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `erasableSyntaxOnly`.
  - TypeScript 7.0 is the latest release, but typescript-eslint 8.73 declares the peer range `typescript >=4.8.4 <6.1.0`. Type-aware linting would break on 7.0, so we stay on 6.0 until typescript-eslint supports 7.
- **No build step to run TS.** Node 26 strips types natively (`process.features.typescript === 'strip'`). Sources import each other with `.ts` extensions, and `rewriteRelativeImportExtensions` rewrites them when emitting. `pnpm build` emits `dist/` for the libraries and typechecks the app.
- **ESLint 10** flat config with typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` (`projectService`).
- **Vitest 5**. A global setup replaces `fetch` with a rejecting stub, so tests can never reach the network. Gemini is always faked.

## Consequences

- A CLI has no compile step (`node apps/ingest/src/cli/ingest.ts`).
- Code must stay "erasable" TypeScript: no enums, namespaces or parameter properties.
- The TypeScript 6 → 7 upgrade waits on typescript-eslint.

## Sources

- Node release schedule: https://github.com/nodejs/Release and https://nodejs.org/en/about/previous-releases
- Corepack no longer bundled from Node 25: https://github.com/nodejs/corepack
- pnpm installation: https://pnpm.io/installation
- typescript-eslint setup: https://typescript-eslint.io/getting-started (peer range from `npm view typescript-eslint@8.73.0 peerDependencies`)
- TypeScript 7.0 announcement: https://devblogs.microsoft.com/typescript/
- Vitest: https://vitest.dev · ESLint: https://eslint.org
