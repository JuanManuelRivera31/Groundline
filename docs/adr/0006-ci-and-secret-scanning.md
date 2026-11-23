# ADR-0006: CI checks and secret scanning with the pinned gitleaks CLI

- Status: Accepted
- Date: 2026-11-22

## Context

Every push must prove that lint, typecheck and the offline tests pass, and that no secret entered the history. Secret scanning has to stay free for a personally owned repository.

## Decision

- **GitHub Actions** (`.github/workflows/ci.yml`) runs two jobs on pushes to `main`, on pull requests and on manual dispatch, with `permissions: contents: read`:
  1. `checks`: `actions/checkout@v6`, `pnpm/action-setup@v6` (pnpm version read from `packageManager`), `actions/setup-node@v7` (Node from `.nvmrc`, pnpm cache), then `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` and `pnpm test`. No database or network is needed, because Gemini is faked.
  2. `secrets`: a full-history checkout plus the **gitleaks CLI v8.30.1** from its official image `ghcr.io/gitleaks/gitleaks:v8.30.1`. It runs `git /repo --config .gitleaks.toml --redact`, the exact command used for the local pre-push scan.
- `gitleaks/gitleaks-action@v3` was tried first. No license is needed for a personal account, but on the initial push (which includes the root commit) it ended with "Unexpected exit code [1]". The action reserves exit code 2 for detected leaks, so this was an execution error, not a finding. Running the pinned CLI avoids depending on the action's push-range logic, and the history is small enough to scan in full every time.
- `.gitleaks.toml` extends the default rules and allowlists only the dummy key used by the fake Gemini client tests.

## Consequences

- Gitleaks upgrades are explicit (bump the image tag). Its README says it now receives security fixes only; its successor, Betterleaks, can be evaluated later.
- No PR comments from the scanner. A failure shows up as a failed job, with redacted findings in the log.

## Sources

- gitleaks CLI and Docker usage: https://github.com/gitleaks/gitleaks
- gitleaks-action (license requirement, exit codes): https://github.com/gitleaks/gitleaks-action
- pnpm/action-setup: https://github.com/pnpm/action-setup · actions/setup-node: https://github.com/actions/setup-node
