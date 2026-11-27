# Groundline (working name)

A reusable AI support-agent kit. It answers customer questions **only** from a company's documentation, cites the source of every claim, says "I don't know" and offers a human hand-off when the evidence is not enough, and ships with a measured accuracy report. Each client gets their own deployment.

> Status: the answer engine is measured on a frozen test set ([accuracy report](evals/plausible/REPORT.md)). Session S4a added the demo API with its protections; the widget, admin panel and deployment come next.

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

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (offline; Gemini is faked), and `pnpm test:db` (against the local Postgres).

## Demo API

```sh
pnpm dev:api                  # http://127.0.0.1:8787
curl -s localhost:8787/v1/health
curl -s -X POST localhost:8787/v1/ask -H 'content-type: application/json' \
  --data-binary '{"question": "How do I exclude my own visits?"}'
```

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/ask {question, lang?}` | Grounded answer with `[n]` citations, sources, `handoff_offered` and a conversation id |
| `POST /v1/handoff {conversation_id, note?}` | Records a hand-off case without asking for personal data; optional webhook in real deployments |
| `GET /v1/health` | Liveness and database check |
| `GET /v1/admin/{conversations,handoffs,gaps,daily}` | Read-only admin views (`Authorization: Bearer ADMIN_TOKEN`) |

Demo protections: 3 questions per minute and 15 per day per IP (stored only as a daily-salted hash), at most 500 characters, a daily AI budget per model with an articles-only fallback, redaction of emails, phone numbers, card numbers and IP addresses before the model and before storage, no Gemini call from the EEA, Switzerland or the UK, and 30-day retention. See [ADR-0012](docs/adr/0012-demo-api-and-protections.md) and [ADR-0013](docs/adr/0013-workers-and-neon-deployment.md).

## Privacy

The Gemini free tier may use submitted content to improve Google's products. Only public documentation is embedded. Customer questions are redacted (emails, phone numbers, card-shaped numbers, IP addresses) before they reach the model or the database, IP addresses are never stored, and conversations are deleted after 30 days. Redaction is pattern-based, so the demo still tells visitors not to share personal data.

## Architecture

See [`docs/adr`](docs/adr) and [`CLAUDE.md`](CLAUDE.md).

## Demo corpus and attribution

The demo indexes the [Plausible Analytics documentation](https://github.com/plausible/docs), © Plausible Analytics and contributors, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The ingest script downloads it at a pinned commit into `data/` (gitignored); it is not part of this repository. Citations link back to the original pages at https://plausible.io/docs.

**Unofficial demo. Not affiliated with or endorsed by Plausible Analytics.**

## License

The kit's source code is released under the [MIT License](LICENSE). Third-party content is covered by its own license; see [NOTICE](NOTICE).
