# ADR-0010: Answer evaluation with code metrics and a Claude judge

- Status: Accepted
- Date: 2026-11-23

## Context

Retrieval metrics (ADR-0008) don't tell whether answers are right, grounded and well-behaved. Some properties can be checked by code (status, citation URLs, quote matches, latency, cost); correctness and support need judgment.

The kit is also sold as an **audit**: grading another vendor's bot on the same questions. So the method must work without our citations.

## Decision

### Runner
`pnpm eval:answers --set dev [--label x] [--dry-run] [--max-requests N]`:
- It refuses `--set test` (CLAUDE.md rule 9).
- Before calling anything it prints the exact plan: questions, how many hit the floor (computed from cached embeddings), generation and embedding requests needed, and quota remaining today.
- It stops, saving a partial run, before retries could cross the request cap (default: needed + 20).
- Output:
  - `evals/runs/<date>-answers[-label].json` with config, prompt version, code metrics and one record per question. A record holds the question, expected behavior and URLs, reference answer, key facts, status, model status, answer, surviving citations with quotes, the full text of the cited sources, invalid citations, removed sentences, max similarity, floor hit, tokens, latency and cost.
  - A Markdown summary.
  - Judge batches in `…-judge/batch-NN.jsonl`, 10 items each, holding only what the judge needs and no code verdicts.

### Code metrics (Wilson 95% on every proportion)
- **Behavior accuracy:** final status vs `expected_behavior` (answer → answered, abstain → insufficient, handoff → handoff, decline → declined).
  - For `prompt_injection`, `answered` with `declined_injection: true` also counts, provided at least one citation survived validation. That is how a wrapped legitimate question is answered, and an off-documentation answer can't produce a verified citation.
  - Also reported as a full expected × status matrix.
- **Citation precision:** the share of surviving citations on answered `answer` questions whose URL is in `expected_urls`, at document level (no anchor) and at section level.
- Verified-quote rate, invalid citations by reason, removed sentences by reason, and answers downgraded for lack of a valid citation.
- **Latency** excludes limiter queue wait, but includes 429/5xx backoff, which a customer would feel. Reported as p50/p95 overall, for model calls only, and for model calls without retries. Tokens, requests and equivalent cost per conversation (one turn) are reported too.

### Judge
- **Claude only, never Gemini:** no model grades itself.
- Fixed rubric `evals/judge/rubric-v1.md`, versioned like prompts.
  - For `answered` items:
    - `correct`: has the essential key facts and contradicts neither the reference nor the evidence;
    - `unsupported_claims`: claims not supported by the **cited source texts**;
    - `complete`: 0–2.
  - For the other statuses: `appropriate`, meaning the behavior matches and the message serves the customer.
- One Sonnet subagent per batch. Each receives only the rubric, its batch file and its output path, so no judge sees other batches, code verdicts or the frozen test set. Judgments go to `…-judgments/batch-NN.jsonl`.
- `pnpm eval:aggregate <run>` checks that every item was judged exactly once with in-range values, then merges code and judge metrics into `…-aggregate.{json,md}`.

### Targets (plan)
| Metric | Definition | Target |
| --- | --- | --- |
| Fabricated answers | answered with `unsupported_claims > 0` / answered | ≤ 5% |
| Correct "I don't know" | abstain questions with status `insufficient` | ≥ 90% |
| Correct answers | answer questions with status `answered` and judge `correct` / all answer questions | ≥ 85% |
| Citations to the right source | document-level citation precision | ≥ 90% |
| Latency | p95 of total latency **in live mode** | ≤ 8 s |

#### Amendment S5b (2026-11-24): where each target is measured
- **Latency target (p95 ≤ 8 s) is measured in live mode**, which is what the customer experiences: model chain, 8 s budget, `unavailable` fallback (ADR-0009). It comes from a seeded live sample of dev questions (`eval:answers --live --sample N`), passed to `pnpm eval:aggregate <run> --live <live-run.json>`.
- **Eval mode** retries the primary model patiently, so its latency mostly measures Google's load. It is reported as **"model latency"**: p95 of model calls that needed no retry. It is informational and not compared with the target.
- **Quality metrics are reported per model.** Each chain model that can answer in live mode (gemini-3.5-flash-lite, gemini-3.1-flash-lite) gets its own eval run as primary (`--model`), with the same judge. The final report states what share of live answers each model gave, so the live quality can be read as a mix of the per-model numbers.

### External audit mode
- `pnpm eval:answers --set dev --external answers.csv` takes columns `id,answer`, with answers from another bot to our questions. It makes no API calls.
- There are no citation or latency metrics.
  - The judge receives the question's **gold source texts** as evidence.
  - The judge also classifies the observed behavior, which replaces our status in the metrics.
- `evals/judge/external-example.csv` shows the format with three made-up rows.

## Consequences

- An LLM judge can be lenient or strict. The rubric is frozen, batches are isolated, and the report quotes failure examples for human review.
- Grading only against cited sources makes `unsupported_claims` strict: a true fact the bot didn't cite counts against it. That is intended for a grounded bot.
- Answer runs commit excerpts of the documentation (CC BY-SA 4.0, see NOTICE).
- The same commands will run on test only once, at the end, with explicit owner approval.
