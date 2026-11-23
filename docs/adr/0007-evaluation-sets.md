# ADR-0007: Frozen evaluation sets with expected behaviors

- Status: Accepted
- Date: 2026-11-23

## Context

Tuning retrieval, and later the "I don't know" threshold and the answer policy, needs labelled questions. Tuning on the same questions used to report quality overfits. Every client deployment will need the same process, so it has to be repeatable.

## Decision

- **Two sets per corpus** in `evals/<corpus>/`:
  - `dev.jsonl`: 60 questions, 45 answerable and 15 not. It is the only set used for tuning.
  - `test.jsonl`: 120 questions, 85 answerable and 35 not. It is frozen.
- **Schema:** `id`, `question`, `answerable`, `category`, `expected_behavior`, `expected_urls` (URLs with anchors), `reference_answer` (1–3 sentences, docs facts only), `key_facts`, `unanswerable_reason`, `source_chunk_ids`.
- **Categories and behaviors:**
  - Answerable: `billing_account`, `install_integrations`, `dashboard_metrics`, `api`, in decreasing share → `answer`.
  - `not_covered`, `off_topic` → `abstain`: say it does not know and offer a human.
  - `account_action` → `handoff`: cannot perform actions; hand off. It may share documented self-service steps, so `expected_urls` may be non-empty.
  - `competitor`, `prompt_injection` → `decline`: politely refuse and steer back.
  - S3 grades the response by behavior.
- **Generation:**
  - The chunked corpus is exported to `data/eval-work/chunks.jsonl` (stable chunk ids).
  - Claude Sonnet subagents write the candidates: one per topic, reading only that topic's documents (`evals/plausible/topics.json`), plus one for unanswerable questions.
  - Style requirements: informal customer tone, vague questions, typos and two-part messages. Headings are never copied.
  - Questions contain no real personal data (emails use example.com; the vendor's own documented address is allowed).
  - Every `not_covered` question was checked with at least two text searches over the corpus.
- **Verification:** separate Claude Opus subagents check every label against the text of its source chunks:
  - keep, fix (unsupported facts, missing equally valid URLs, wrong behavior), or discard;
  - unanswerable questions get independent searches;
  - the counts are recorded in `MANIFEST.json`.
- **Build and freeze** (`pnpm eval:build-sets`, deterministic seed):
  - schema validation against the chunk index;
  - near-duplicates dropped (token Jaccard ≥ 0.8);
  - questions that share a source chunk **and** the same expected behavior, or are similar (Jaccard ≥ 0.6), stay in the same set. An answer question and a handoff question on the same chunk are different tasks and may be split;
  - category quotas per set;
  - **no document supplies more than 5% of a set** (≤3 in dev, ≤6 in test);
  - ids assigned.
  - The builder refuses to run if either set exists. It writes `MANIFEST.json` (sha256 of both sets and of `chunks.jsonl`, corpus commit, chunker, verification counts, split parameters) and `audit_sample.csv` (20 test questions, seed 20261123) for owner audit. It prints only counts and the hash for test.
- **Access rule** (CLAUDE.md rule 9): `test.jsonl` is never read, printed or used for tuning. `eval:retrieval` refuses `--set test` until a final-run command with explicit owner approval exists.
- **License:** the sets adapt CC BY-SA 4.0 documentation and carry that license (`evals/plausible/LICENSE`, NOTICE).

## Consequences

- If the corpus commit or the chunker changes, chunk ids and URLs can change. The sets are tied to `chunks_file_sha256` in the manifest, so a corpus bump requires re-validating (and possibly re-labelling) them.
- LLM-written questions can be cleaner than real traffic. The owner audit sample and, later, real anonymized questions mitigate this.
- With 15 non-answer questions in dev, the separation metrics have wide intervals (reported with bootstrap CIs).
