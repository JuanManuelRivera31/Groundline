# ADR-0011: Frozen test run protocol

- Status: Accepted
- Date: 2026-11-26

## Context

`evals/plausible/test.jsonl` (120 questions) was frozen at S2 and has never been read. Every tuning decision in S3–S5c used dev only.

The owner has explicitly approved one final run (S6) on the configuration frozen in S5c, plus the S5d availability amendment, which leaves eval mode unchanged.

The test set loses its value if it is run twice, if the configuration changes between models, or if anything is tuned after seeing it. Those rules need to be enforced by code, not only by habit.

## Decision

- **The gate.** `pnpm eval:answers --set test` runs only with `--final`. Every other command, and `--set test` without `--final`, keeps refusing the test set (CLAUDE.md rule 9).
- **Integrity checks before the file is parsed.** The final run:
  - checks the sha256 of `test.jsonl` against `MANIFEST.json` and aborts on any mismatch;
  - requires a clean working tree (tracked files);
  - stores the code commit and the verified hash in the run (`frozenTest: { sha256, commit }`).
- **One run per label.** A final run needs a `--label`, such as `test-35`, `test-31` or `test-live`.
  - A second run with a label already used, on any date, is refused. An interrupted run can only continue with `--resume`.
  - `--prompt`, `--external` and `--dry-run` are refused on the final run; quota is checked with a dev dry run.
  - `--sample` is allowed only for the live sample.
- **Quality** is measured in eval mode, with one run per chain model (gemini-3.5-flash-lite and gemini-3.1-flash-lite). Each run is judged by isolated Sonnet subagents with rubric v1, as on dev, so test and dev are comparable.
- **Second judge.** `pnpm eval:second-judge <run.json>` draws a seeded sample of 30 items (seed 20261126) for a second, larger judge (Claude Opus), with the same rubric. Both judges are Claude models, so they come from a different model family than the Gemini models that write the answers. `--compare` reports agreement with the first judge:
  - on `correct` and on `unsupported_claims` (any claim, and the same count), with Cohen's kappa;
  - on `appropriate` for non-answered items.
  - `--stratified` draws a second sample: every first-judge failure plus 20 seeded passes (seed 20261127), mixed in run order. Agreement is reported per stratum, because a random sample with few failures cannot test agreement on them.
  - The second judge is a check only. The official figures stay the first judge's, and discrepancies are reported as they are.
- **Live sample.** 30 test questions with the fixed sample seed and realistic arrivals (mean 12 s, seed 20261125). It uses `--no-embed-cache`, the model chain and the hedge, at US peak hours.
- **Nothing is tuned after test is read.** Results are reported as they are in `evals/plausible/REPORT.md` and `docs/reports/s6.md`, including misses. The human audit of `audit_sample.csv` stays pending until the owner provides it.

## Consequences

- The published numbers map to one commit and one verified test file.
- A failed or interrupted run cannot be silently retried with a fresh start.
- Any later change to the system needs a new held-out set to be measured without bias. This test set is spent once its results are read.
