# Aggregate: evals/runs/2026-11-23-answers.json

- Kind: answers; judged items: 71 (8 batch files); judge: claude-sonnet.

## Targets

| Metric | Value [Wilson 95%] | Target | Met |
| --- | --- | --- | --- |
| Fabricated answers (answered with unsupported claims) | 11.1% (3/27) [3.9%–28.1%] | ≤ 5% | no |
| Correct "I don't know" on abstain questions | 92.9% (13/14) [68.5%–98.7%] | ≥ 90% | yes |
| Correct answers on answer questions | 48.9% (22/45) [35.0%–63.0%] | ≥ 85% | no |
| Citations to the correct source (document level) | 94.3% (33/35) [81.4%–98.4%] | ≥ 90% | yes |
| Latency p95 | 181.06 s | ≤ 8 s | no |

## Judge

- Correct among answered: 85.2% (23/27) [67.5%–94.1%]; unsupported claims total: 3; completeness mean: 1.63 / 2.
- Appropriate among non-answered: 47.7% (21/44) [33.8%–62.1%].
  - expected answer: 0.0% (0/22) [0.0%–14.9%]
  - expected abstain: 100.0% (13/13) [77.2%–100.0%]
  - expected handoff: 100.0% (3/3) [43.9%–100.0%]
  - expected decline: 83.3% (5/6) [43.6%–97.0%]

## Code metrics

- Questions: 71; generation requests: 147; model calls: 66.
- Behavior accuracy: 63.4% (45/71) [51.8%–73.6%].
  - answer: 51.1% (23/45) [37.0%–65.0%]
  - abstain: 92.9% (13/14) [68.5%–98.7%]
  - handoff: 75.0% (3/4) [30.1%–95.4%]
  - decline: 75.0% (6/8) [40.9%–92.9%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 35 citations): document 94.3% (33/35) [81.4%–98.4%]; section 88.6% (31/35) [74.0%–95.5%].
- Quotes verified: 52.3% (46/88) [42.0%–62.4%]; invalid by reason: {"quote_too_long":42}.
- Removed sentences: failed citation 66, unmarked claim 4; downgraded to insufficient (no valid citation): 20; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (excl. queue wait) all: p50 4.35 s, p95 181.06 s, max 493.09 s; model calls only: p50 5.23 s, p95 195.01 s; model calls without retries (n=32): p95 4.30 s. Answers that needed retries: 34. Queue wait total 45.4 s.
- Tokens per model call (mean): prompt 2478, output 205, thoughts 0.
- Equivalent cost at list price: $0.001171 per conversation, $0.0831 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined |
| --- | --- | --- | --- | --- |
| answer | 23 | 21 | 1 | 0 |
| abstain | 1 | 13 | 0 | 0 |
| handoff | 1 | 0 | 3 | 0 |
| decline | 2 | 1 | 0 | 5 |

