# Aggregate: evals/runs/2026-11-24-answers-v2.json

- Kind: answers; judged items: 71 (8 batch files); judge: claude-sonnet.

## Targets

| Metric | Value [Wilson 95%] | Target | Met |
| --- | --- | --- | --- |
| Fabricated answers (answered with unsupported claims) | 2.2% (1/45) [0.4%–11.6%] | ≤ 5% | yes |
| Correct "I don't know" on abstain questions | 100.0% (14/14) [78.5%–100.0%] | ≥ 90% | yes |
| Correct answers on answer questions | 91.1% (41/45) [79.3%–96.5%] | ≥ 85% | yes |
| Citations to the correct source (document level) | 95.3% (101/106) [89.4%–98.0%] | ≥ 90% | yes |
| Latency p95 | 85.49 s | ≤ 8 s | no |

## Judge

- Correct among answered: 91.1% (41/45) [79.3%–96.5%]; unsupported claims total: 1; completeness mean: 1.76 / 2.
- Appropriate among non-answered: 88.5% (23/26) [71.0%–96.0%].
  - expected answer: 0.0% (0/2) [0.0%–65.8%]
  - expected abstain: 100.0% (14/14) [78.5%–100.0%]
  - expected handoff: 100.0% (3/3) [43.9%–100.0%]
  - expected decline: 85.7% (6/7) [48.7%–97.4%]

## Code metrics

- Questions: 71; generation requests: 127; model calls: 66.
- Behavior accuracy: 94.4% (67/71) [86.4%–97.8%].
  - answer: 95.6% (43/45) [85.2%–98.8%]
  - abstain: 100.0% (14/14) [78.5%–100.0%]
  - handoff: 75.0% (3/4) [30.1%–95.4%]
  - decline: 87.5% (7/8) [52.9%–97.8%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 106 citations): document 95.3% (101/106) [89.4%–98.0%]; section 93.4% (99/106) [87.0%–96.8%].
- Quotes verified: 100.0% (116/116) [96.8%–100.0%]; invalid by reason: {}.
- Removed sentences: failed citation 0, unmarked claim 1; downgraded to insufficient (no valid citation): 0; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (excl. queue wait) all: p50 1.83 s, p95 85.49 s, max 152.61 s; model calls only: p50 2.07 s, p95 98.31 s; model calls without retries (n=38): p95 3.26 s. Answers that needed retries: 28. Queue wait total 121.1 s.
- Tokens per model call (mean): prompt 2742, output 198, thoughts 0.
- Availability: unavailable 0.0% (0/71) [0.0%–5.1%]; answered by {"gemini-3.5-flash-lite":66}; hops {"0":66}; attempts by model/status {"gemini-3.5-flash-lite":{"200":66,"503":61}}; retrieval fallback {"vector":71}.
- Quote words: all min 6 / p25 16 / median 20 / p75 29.25 / max 60 (n=116); valid min 6 / p25 16 / median 20 / p75 29.25 / max 60 (n=116); >40 words: 7, >80 words: 0.
- Equivalent cost at list price: $0.001228 per conversation, $0.0872 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 43 | 2 | 0 | 0 | 0 |
| abstain | 0 | 14 | 0 | 0 | 0 |
| handoff | 1 | 0 | 3 | 0 | 0 |
| decline | 1 | 1 | 0 | 6 | 0 |

