# Groundline accuracy report: Plausible docs demo (frozen test set)

Groundline is a support agent that answers **only** from a company's documentation. It cites the source of every claim, and when the documentation does not cover a question it says so and offers a human.

This report measures it on the public [Plausible Analytics documentation](https://github.com/plausible/docs) with a held-out test set that was frozen before any tuning and read exactly once.

- Final run: **2026-11-26, 20:35–21:12 UTC**.
- Code commit: `c842a0987388434f61f82822a6c22bd12ea51cea`.
- Test set sha256: `44121cce79769bd6c7bb175d307c7e4b8995fa7f858b176f0ce650fb0c5bf9a7`, verified against `MANIFEST.json` by the run itself.

## Results at a glance

| | Target | Primary model (gemini-3.5-flash-lite) | Fallback model (gemini-3.1-flash-lite) |
| --- | --- | --- | --- |
| Fabricated answers (answers with an unsupported claim) | ≤ 5% | **1.2%** (1/81) [0.2–6.7] ✓ | 2.3% (2/86) [0.6–8.1] ✓ |
| Correct "I don't know" on questions the docs don't cover | ≥ 90% | **100%** (19/19) [83.2–100] ✓ | 89.5% (17/19) [68.6–97.1] ✗ |
| Correct answers on answerable questions | ≥ 85% | **88.2%** (75/85) [79.7–93.5] ✓ | 90.6% (77/85) [82.5–95.2] ✓ |
| Citations to a labelled source document | ≥ 90% | 86.1% (186/216) [80.9–90.1] ✗ | 81.8% (189/231) [76.3–86.3] ✗ |

Brackets are 95% Wilson intervals.
- The primary model meets 3 of the 4 quality targets.
- The fallback model, which answers only when the primary fails in live use, meets 2 of 4.
- Both miss the citation target. That metric is strict; see "What the citation metric does and does not say".

| Live traffic (30 test questions, realistic arrivals) | Target | Result |
| --- | --- | --- |
| Time to any response, p95 | ≤ 8 s | **4.76 s** ✓ |
| Unavailable rate | ≤ 5% | **0%** (0/30) [0.0–11.4] ✓ (point estimate) |
| Latency of model-delivered responses, p95 (informational) | — | 4.76 s |
| Query embedding latency, p95, uncached (informational) | — | 0.57 s |
| Share of live responses | — | gemini-3.5-flash-lite **28**, gemini-3.1-flash-lite **1**, documentation floor (no model) **1** |

## What is measured, and how

### The corpus and the two question sets

- **Corpus.** `plausible/docs` at commit `e9a092a`, CC BY-SA 4.0. It is chunked into 789 heading-aware chunks.
- **Two sets**, built once and frozen (`MANIFEST.json`):

  | Set | Questions | answer | abstain | handoff | decline | Use |
  | --- | --- | --- | --- | --- | --- | --- |
  | `dev.jsonl` | 71 | 45 | 14 | 4 | 8 | all tuning |
  | `test.jsonl` | 120 | 85 | 19 | 6 | 10 | this report only |

  - *answer*: the docs answer it.
  - *abstain*: the docs don't cover it, or it is off-topic; the bot must say so and offer a person.
  - *handoff*: an account action we must perform for the customer.
  - *decline*: a competitor comparison or a prompt injection.
- **How the questions were written.**
  - Claude Sonnet agents wrote candidates per documentation topic in an informal customer voice, with typos, vague and two-part messages.
  - Separate Claude Opus agents checked every label against the source text: 204 kept or corrected, 2 discarded.
  - No real personal data is in any question.
- **No leakage between sets.**
  - Questions that share a source chunk and the same expected behavior, or that are near-duplicates, stay in one set. The highest dev/test token similarity is Jaccard 0.357.
  - No document supplies more than 5% of a set.

### The freeze

- `MANIFEST.json` stores the sha256 of both sets. The test set was never read, printed or used during development (project rule 9).
- The only command that reads it requires an explicit `--final` flag and the owner's approval (ADR-0011). Before parsing, it checks the hash, requires a clean working tree and records the commit.
- Each configuration may run once; an interrupted run can only be resumed.
- **Before the test run, the system was frozen** after three tuning iterations on dev:
  - prompt v4;
  - citation validator;
  - similarity floor 0.600;
  - retrieval: vector search, 20 candidates → 6 sources;
  - models and a 7.5 s live budget.
- One availability change was approved before the test run: a live-mode hedge, which starts the fallback model when the primary has not answered in 3 s. It only applies to live traffic and does not affect the eval-mode quality numbers.
- **Nothing was changed after test was read.** Every number here is from the single run.

### How answers are graded

1. **By code**, on every question:
   - the final status against the expected behavior;
   - whether each cited quote appears verbatim in the cited source (unverifiable sentences are removed before the customer sees them);
   - whether each citation points to one of the labelled source documents;
   - latency and availability.
2. **By an LLM judge from a different model family.** The answers are written by Google Gemini models and graded by Anthropic Claude models.
   - Each judge is an isolated Claude Sonnet agent that sees only the rubric (`evals/judge/rubric-v1.md`) and a batch of 10 items: question, reference answer, key facts, the bot's answer and the text of the sources it cited.
   - For answered items it decides whether the answer is correct and complete, and counts claims not supported by the cited text. For the other items it decides whether the behavior was appropriate.
   - "Fabricated" means at least one unsupported claim.
3. **A second judge** (Claude Opus, same rubric, isolated) re-graded a seeded random sample of 30 primary-model items (seed 20261126). It agreed with the first judge on **every item**:
   - `correct` on 21/21 answered items;
   - `unsupported_claims` on 21/21, both "any" and the exact count;
   - `appropriate` on 9/9 non-answered items (Cohen's κ = 1.00).

   The sample contained no answered item that either judge marked incorrect, so κ for `correct` is undefined and the sample does not test agreement on failures.
4. **Human audit: pending.** A fixed sample of 20 test questions (`audit_sample.csv`, seed 20261123) is reserved for a human review of labels and grades. This report will be updated with its result.

### Live traffic

- 30 test questions (fixed sample seed 20261123) arrived one at a time, with random gaps averaging 12 s (seed 20261125), as in a demo.
- They ran at 21:03–21:12 UTC, during US peak hours.
- Each question was embedded live (no cache), answered through the model chain within a 7.5 s budget with the 3 s hedge, and timed end to end, queue wait included.

## Results in detail (test set)

### Behavior by expected behavior (code)

| Expected | Primary (3.5) | Fallback (3.1) |
| --- | --- | --- |
| answer (85) | 80 answered, 4 "I don't know", 1 handoff | 81 answered, 1 "I don't know", 3 handoff |
| abstain (19) | 19 "I don't know" | 17 "I don't know", 2 answered |
| handoff (6) | 6 handoff | 4 handoff, 2 answered |
| decline (10) | 7 declined, 2 "I don't know", 1 answered* | 7 declined, 2 "I don't know", 1 answered* |
| **Behavior accuracy** | **94.2%** (113/120) | 91.7% (110/120) |

\* A prompt injection wrapped around a real product question. Answering the product question while refusing the injection, with a verified citation, counts as correct.

### Other measurements

| | Primary (3.5) | Fallback (3.1) |
| --- | --- | --- |
| Judge: correct among answered | 93.8% (76/81) | 90.7% (78/86) |
| Judge: completeness (0–2) | 1.79 | 1.81 |
| Judge: appropriate among non-answered | 82.1% (32/39) | 82.4% (28/34) |
| Quotes verified verbatim | 98.3% (230/234) | 99.6% (261/262) |
| Citations to the labelled section (stricter) | 84.3% | 79.2% |
| Model latency p95, no retries (eval) | 2.31 s | 15.01 s |
| Equivalent cost per conversation at list price | $0.0015 | $0.0011 |

The real cost is $0: everything runs on the Gemini free tier.

### What the citation metric does and does not say

A citation counts as correct only if it points to one of the documents the question was labelled with. Every surviving citation is a verbatim quote from the document it names (the validator removes the rest), so a miss means "a different document than the label", not "an invented quote".

On the primary model:
- the 30 off-label citations fall on 19 questions;
- 14 of those 19 also cite a labelled document;
- the judge rated 16 of the 19 answers correct.

The labels list the documents the question writer used. They are not an exhaustive list of every page that states the same fact.

The target is still missed as defined. We report it as a miss and did not relabel anything after seeing test.

### Remaining failures on the primary model

| Kind | Questions | Notes |
| --- | --- | --- |
| "I don't know" on an answerable question | test-008, test-015, test-036, test-049 | test-015 and test-036 were downgraded because no citation survived validation; test-049 ran out of output tokens (`MAX_TOKENS`). |
| Handoff on an answerable question | test-085 | The docs say to contact support to turn off 2FA. The bot handed off, with the right content. |
| Incomplete or incorrect answers | test-021, test-038, test-045, test-103, test-119 | Mostly API questions (6/9 correct in the `api` category): a missing parameter, a missing key fact or a missing command. |
| Unsupported claim | test-082 | The answer presents "add a VAT number" as a way to correct a wrong one. This is the one fabricated answer. |
| Prompt injection answered "I don't know" | test-033, test-118 | Off-topic injections fell below the similarity floor (0.595 and 0.577 vs 0.600), so the model never saw them and the safe fallback replied. Safe, but not the expected polite refusal. |

The fallback model adds:
- 2 answered abstain questions (test-024, test-039): adjacent facts instead of "the docs don't cover it";
- 2 answered handoff questions (test-069, test-099): self-service steps instead of a hand-off;
- 2 more answer→handoff misses (test-079, test-096);
- 2 unsupported claims (test-021, test-082).

## Dev vs test: is there overfitting?

Dev is the set the system was tuned on (three iterations). Test was never seen.

| Metric | Primary, dev | **Primary, test** | Fallback, dev | **Fallback, test** |
| --- | --- | --- | --- | --- |
| Fabricated answers | 0.0% (0/43) [0.0–8.2] | **1.2%** (1/81) [0.2–6.7] | 0.0% (0/48) [0.0–7.4] | **2.3%** (2/86) [0.6–8.1] |
| Correct "I don't know" | 92.9% (13/14) [68.5–98.7] | **100%** (19/19) [83.2–100] | 85.7% (12/14) [60.1–96.0] | **89.5%** (17/19) [68.6–97.1] |
| Correct answers | 88.9% (40/45) [76.5–95.2] | **88.2%** (75/85) [79.7–93.5] | 93.3% (42/45) [82.1–97.7] | **90.6%** (77/85) [82.5–95.2] |
| Citations to a labelled document | 96.9% (127/131) [92.4–98.8] | **86.1%** (186/216) [80.9–90.1] | 85.9% (122/142) [79.2–90.7] | **81.8%** (189/231) [76.3–86.3] |
| Behavior accuracy (code) | 93.0% (66/71) | **94.2%** (113/120) | 94.4% (67/71) | **91.7%** (110/120) |

- **Answer quality, abstention and fabrication carry over from dev to test.** All differences are within the intervals.
- **Citation precision on the primary model dropped** from 96.9% to 86.1%, and the intervals do not overlap. This is the clearest sign of dev-specific tuning, or of dev labels that happened to match the model's citation habits better.
- The fallback model's citation precision was already below target on dev.

## Known limitations

- **Small samples.**
  - 19 abstain, 6 handoff and 10 decline questions in test.
  - 30 questions in the live sample: 0 unavailable has a 95% upper bound of 11.4%, so the sample does not establish ≤ 5% with confidence.
  - The live result also depends on free-tier capacity at that hour. On dev, without the hedge, the same live setup saw 33% unavailable when the primary model stalled at off-peak hours.
- **Synthetic questions.** LLMs wrote the questions and labels and an LLM verified them; they are cleaner than real customer traffic.
- **One corpus.** Results are for one product's documentation in English. A new client deployment needs its own sets.
- **The fallback model is weaker.** In live use it answered 1 of 30 here, but at busy times it can serve a larger share. It misses the abstain and citation targets on its own.
- **Off-topic prompt injections** below the similarity floor get the safe "I don't know" reply instead of a refusal.
- **Rate limits are assumed.** The client uses 10 requests/min and 200/day per model; the real free-tier values were not read from Google's console. No quota error (HTTP 429) was seen in any run.

## What was NOT measured

- Real customer questions, other languages (the prompt supports replying in the customer's language, but test is English), and multi-turn conversations.
- Answers in a deployed widget or API (only the engine through the CLI).
- Sustained or concurrent traffic beyond the 30-question samples. A 30-in-90-s burst on dev is informational only.
- How often a human hand-off actually resolves the issue.
- Human grading. The audit is **pending**.

## Reproduce

```
pnpm eval:answers --set test --final --label test-35                                  # owner-approved, once
pnpm eval:answers --set test --final --model gemini-3.1-flash-lite --label test-31
pnpm eval:answers --set test --final --live --sample 30 --arrival-mean-ms 12000 --no-embed-cache --label test-live
pnpm eval:aggregate evals/runs/2026-11-26-answers-test-35.json --live evals/runs/2026-11-26-answers-test-live.json
pnpm eval:second-judge evals/runs/2026-11-26-answers-test-35.json --compare
```

- **Run files:** `evals/runs/2026-11-26-answers-test-{35,31,live}.*`, including every answer, citation, judgment and the judge-agreement report.
- **License:** the question sets and the cited excerpts adapt the Plausible documentation under CC BY-SA 4.0 (see `LICENSE`).
