# Aggregate: evals/runs/2026-11-23-answers-revalidated.json

- Kind: answers; judged items: 71 (3 batch files); judge: claude-sonnet.

## Targets

| Metric | Value [Wilson 95%] | Target | Met |
| --- | --- | --- | --- |
| Fabricated answers (answered with unsupported claims) | 7.1% (3/42) [2.5%–19.0%] | ≤ 5% | no |
| Correct "I don't know" on abstain questions | 92.9% (13/14) [68.5%–98.7%] | ≥ 90% | yes |
| Correct answers on answer questions | 82.2% (37/45) [68.7%–90.7%] | ≥ 85% | no |
| Citations to the correct source (document level) | 91.4% (53/58) [81.4%–96.3%] | ≥ 90% | yes |
| Latency p95 | 181.06 s | ≤ 8 s | no |

## Judge

- Correct among answered: 90.5% (38/42) [77.9%–96.2%]; unsupported claims total: 3; completeness mean: 1.69 / 2.
- Appropriate among non-answered: 72.4% (21/29) [54.3%–85.3%].
  - expected answer: 0.0% (0/7) [0.0%–35.4%]
  - expected abstain: 100.0% (13/13) [77.2%–100.0%]
  - expected handoff: 100.0% (3/3) [43.9%–100.0%]
  - expected decline: 83.3% (5/6) [43.6%–97.0%]

## Code metrics

- Questions: 71; generation requests: 147; model calls: 66.
- Behavior accuracy: 84.5% (60/71) [74.3%–91.1%].
  - answer: 84.4% (38/45) [71.2%–92.3%]
  - abstain: 92.9% (13/14) [68.5%–98.7%]
  - handoff: 75.0% (3/4) [30.1%–95.4%]
  - decline: 75.0% (6/8) [40.9%–92.9%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 58 citations): document 91.4% (53/58) [81.4%–96.3%]; section 86.2% (50/58) [75.1%–92.8%].
- Quotes verified: 95.5% (84/88) [88.9%–98.2%]; invalid by reason: {"quote_too_long":4}.
- Removed sentences: failed citation 15, unmarked claim 4; downgraded to insufficient (no valid citation): 5; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (excl. queue wait) all: p50 4.35 s, p95 181.06 s, max 493.09 s; model calls only: p50 5.23 s, p95 195.01 s; model calls without retries (n=32): p95 4.30 s. Answers that needed retries: 34. Queue wait total 45.4 s.
- Tokens per model call (mean): prompt 2478, output 205, thoughts 0.
- Availability: unavailable 0.0% (0/71) [0.0%–5.1%]; answered by {}; hops {"0":66}; attempts by model/status {}; retrieval fallback {"vector":71}.
- Quote words: all min 7 / p25 18 / median 24 / p75 36.25 / max 139 (n=72); valid min 7 / p25 17.75 / median 23 / p75 33.25 / max 58 (n=68); >40 words: 16, >80 words: 4.
- Equivalent cost at list price: $0.001171 per conversation, $0.0831 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 38 | 6 | 1 | 0 | 0 |
| abstain | 1 | 13 | 0 | 0 | 0 |
| handoff | 1 | 0 | 3 | 0 | 0 |
| decline | 2 | 1 | 0 | 5 | 0 |

