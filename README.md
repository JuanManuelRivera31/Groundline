# Groundline (working name)

A reusable AI support-agent kit. It answers customer questions **only** from a company's documentation, cites the source of every claim, says "I don't know" and offers a human hand-off when the evidence is not enough, and ships with a measured accuracy report. Each client gets their own deployment.

> Status: session 1 — repository scaffold, database, ingestion and retrieval debugging. The answering API, widget, admin and evals come next.

## Requirements

- Node 26 (Active LTS)
- pnpm 12 via Corepack. Node ≥ 25 no longer bundles Corepack: `npm install -g corepack` then `corepack enable pnpm`
- Docker Desktop (local Postgres + pgvector)
- A Gemini API key on the **free tier** (no billing)

## Quick start

```sh
cp .env.example .env          # then set GEMINI_API_KEY
pnpm install
pnpm db:up                    # Postgres 18 + pgvector on 127.0.0.1:54329
pnpm db:migrate
pnpm ingest --source plausible --dry-run   # estimate only, no API calls
pnpm ingest --source plausible
pnpm search:debug "How do I cancel my subscription?"
pnpm chunks:stats --source plausible
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (offline; Gemini is faked).

## Privacy

The Gemini free tier may use submitted content to improve Google's products. Only public documentation is embedded; never send personal data through this kit while it uses the free tier.

## Architecture

See [`docs/adr`](docs/adr) and [`CLAUDE.md`](CLAUDE.md).

## Demo corpus and attribution

The demo indexes the [Plausible Analytics documentation](https://github.com/plausible/docs), © Plausible Analytics and contributors, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The ingest script downloads it at a pinned commit into `data/` (gitignored); it is not part of this repository. Citations link back to the original pages at https://plausible.io/docs.

**Unofficial demo. Not affiliated with or endorsed by Plausible Analytics.**

## License

The kit's source code is released under the [MIT License](LICENSE). Third-party content is covered by its own license; see [NOTICE](NOTICE).
