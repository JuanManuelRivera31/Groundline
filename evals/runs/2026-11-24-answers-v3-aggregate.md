# Aggregate: evals/runs/2026-11-24-answers-v3.json

- Kind: answers; judged items: 71 (8 batch files); judge: claude-sonnet.

## Targets

| Metric | Value [Wilson 95%] | Target | Met |
| --- | --- | --- | --- |
| Fabricated answers (answered with unsupported claims) | 0.0% (0/43) [0.0%–8.2%] | ≤ 5% | yes |
| Correct "I don't know" on abstain questions | 100.0% (14/14) [78.5%–100.0%] | ≥ 90% | yes |
| Correct answers on answer questions | 88.9% (40/45) [76.5%–95.2%] | ≥ 85% | yes |
| Citations to the correct source (document level) | 95.3% (101/106) [89.4%–98.0%] | ≥ 90% | yes |
| Model latency p95 (eval mode, no retries; informational) | 5.28 s | — | — |
| Latency p95 (live mode), n=30 | 8.02 s | ≤ 8 s | no |

## Judge

- Correct among answered: 95.3% (41/43) [84.5%–98.7%]; unsupported claims total: 0; completeness mean: 1.91 / 2.
- Appropriate among non-answered: 85.7% (24/28) [68.5%–94.3%].
  - expected answer: 0.0% (0/4) [0.0%–49.0%]
  - expected abstain: 100.0% (14/14) [78.5%–100.0%]
  - expected handoff: 100.0% (3/3) [43.9%–100.0%]
  - expected decline: 100.0% (7/7) [64.6%–100.0%]

## Code metrics

- Questions: 71; generation requests: 75; model calls: 66.
- Behavior accuracy: 93.0% (66/71) [84.6%–97.0%].
  - answer: 91.1% (41/45) [79.3%–96.5%]
  - abstain: 100.0% (14/14) [78.5%–100.0%]
  - handoff: 75.0% (3/4) [30.1%–95.4%]
  - decline: 100.0% (8/8) [67.6%–100.0%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 106 citations): document 95.3% (101/106) [89.4%–98.0%]; section 94.3% (100/106) [88.2%–97.4%].
- Quotes verified: 98.3% (116/118) [94.0%–99.5%]; invalid by reason: {"quote_too_long":2}.
- Removed sentences: failed citation 1, unmarked claim 3; downgraded to insufficient (no valid citation): 1; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (excl. queue wait) all: p50 1.39 s, p95 6.23 s, max 10.21 s; model calls only: p50 1.46 s, p95 6.25 s; model calls without retries (n=57): p95 5.28 s. Answers that needed retries: 9. Queue wait total 230.9 s.
- Tokens per model call (mean): prompt 3032, output 216, thoughts 0.
- Availability: unavailable 0.0% (0/71) [0.0%–5.1%]; answered by {"gemini-3.5-flash-lite":66}; hops {"0":66}; attempts by model/status {"gemini-3.5-flash-lite":{"200":66,"503":9}}; retrieval fallback {"vector":71}.
- Quote words: all min 4 / p25 15 / median 18 / p75 26.75 / max 83 (n=118); valid min 4 / p25 15 / median 18 / p75 26 / max 80 (n=116); >40 words: 9, >80 words: 2.
- Equivalent cost at list price: $0.001352 per conversation, $0.0960 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 41 | 3 | 1 | 0 | 0 |
| abstain | 0 | 14 | 0 | 0 | 0 |
| handoff | 1 | 0 | 3 | 0 | 0 |
| decline | 1 | 0 | 0 | 7 | 0 |

