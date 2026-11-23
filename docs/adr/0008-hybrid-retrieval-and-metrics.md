# ADR-0008: Hybrid retrieval with Reciprocal Rank Fusion, measured on dev

- Status: Accepted
- Date: 2026-11-23

## Context

Vector search catches paraphrases. Full-text search catches exact product terms (plan names, settings, API fields). The answer model in S3 will see the top N chunks, so retrieval quality has to be measured, not assumed.

## Decision

- **Candidates:** `Db.searchCandidates` returns the top `c` vector hits (cosine, HNSW) and the top `c` full-text hits. Full-text uses OR semantics over `plainto_tsquery` lexemes, ranked by `ts_rank_cd`. Each hit carries its cosine similarity to the query, full-text hits included. The database does no fusion.
- **Fusion** in `packages/core` (`fuseRrf`), pure and runtime-agnostic:
  - Reciprocal Rank Fusion, `score = Σ 1/(k + rank)` (Cormack, Clarke & Büttcher, SIGIR 2009), defaults `k = 60`, `c = 20`, `N = 8`.
  - Results are deduplicated by chunk, and ties are broken deterministically.
  - Every result exposes its rank and score in each list, the RRF score and the cosine.
  - RRF needs no score normalization between incompatible scales (cosine vs `ts_rank_cd`).
- **Metrics** (`packages/evals`):
  - For `answer` questions: recall@1/3/5/8 and MRR, at document level (URL without anchor) and section level (URL with anchor), with **Wilson 95% intervals** for recall.
  - Separation signal: the **max cosine** among the vector candidates. AUC (Mann-Whitney, ties = 0.5) between `answer` and `abstain` **only**, with a **stratified percentile bootstrap 95% CI** (2,000 resamples, seed 20261123).
  - The `handoff` and `decline` distributions are reported separately. Those cases are handled by policy in S3, not by a similarity threshold, because they often retrieve relevant chunks (e.g. "refund me" finds the refund FAQ).
  - No threshold is fixed in S2.
- **Selection rule** for the tuned configuration, on dev only, with at most 4 hybrid configurations, all recorded in `evals/runs/`:
  1. section-level recall@8 (N = 8 is what the model will see);
  2. then MRR;
  3. document-level metrics break ties.
- Query embeddings use the cache (`RETRIEVAL_QUERY`, usage kind `embed_query_eval`). The runner shows the requests needed and the quota remaining today before any call.

## Results on dev v2 (2026-11-23)

Six runs are recorded in `evals/runs/2026-11-23-*`: vector, fts, and four hybrid configurations, which is the cap.

| Config | Section R@1 | R@5 | R@8 | MRR |
| --- | --- | --- | --- | --- |
| vector | 75.6% | 95.6% | **97.8%** | **0.837** |
| fts | 26.7% | 60.0% | 64.4% | 0.379 |
| hybrid k=60, c=20 | 48.9% | 84.4% | 93.3% | 0.641 |
| hybrid k=20, c=20 | 48.9% | 84.4% | 93.3% | 0.641 |
| hybrid k=60, c=10 (best hybrid) | 48.9% | 91.1% | 95.6% | 0.648 |
| hybrid k=60, c=8 | 48.9% | 88.9% | 95.6% | 0.643 |

- **Best hybrid configuration** by the rule: `k = 60, c = 10, N = 8`.
- **Vector-only beats every hybrid configuration on dev at section level.** Equal-weight RRF lets a weak full-text list displace correct vector top-1 hits: 14 lost top-1 hits versus 2 gained.
- **Recommendation for S3:** default to `vector` (c = 20, N = 8) and keep hybrid selectable.
- Improving the full-text list or weighting the fusion is outside S2's tuning knobs (k, N, candidates). It is proposed in `docs/reports/s2.md`.

## Consequences

- Hybrid retrieval costs one extra SQL query per question. There are no additional API calls, since the query is embedded once.
- With 45 answerable dev questions, a recall difference smaller than ~10 points is within noise. Configurations are compared with that in mind.

## Sources

- Cormack, Clarke, Büttcher. "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods". SIGIR 2009. https://dl.acm.org/doi/10.1145/1571941.1572114
- PostgreSQL text search ranking (`ts_rank_cd`, `plainto_tsquery`): https://www.postgresql.org/docs/current/textsearch-controls.html
- Wilson score interval: Wilson, E. B. (1927), JASA 22(158). https://doi.org/10.1080/01621459.1927.10502953
