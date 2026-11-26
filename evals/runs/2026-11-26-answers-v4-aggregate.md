# Aggregate: evals/runs/2026-11-26-answers-v4.json

- Kind: answers; judged items: 71 (8 batch files); judge: claude-sonnet.

## Targets

| Metric | Value [Wilson 95%] | Target | Met |
| --- | --- | --- | --- |
| Fabricated answers (answered with unsupported claims) | 0.0% (0/43) [0.0%–8.2%] | ≤ 5% | yes |
| Correct "I don't know" on abstain questions | 92.9% (13/14) [68.5%–98.7%] | ≥ 90% | yes |
| Correct answers on answer questions | 88.9% (40/45) [76.5%–95.2%] | ≥ 85% | yes |
| Citations to the correct source (document level) | 96.9% (127/131) [92.4%–98.8%] | ≥ 90% | yes |
| Model latency p95 (eval mode, no retries; informational) | 5.81 s | — | — |
| Time to any response p95 (live), realistic arrivals, n=30 | 7.53 s | ≤ 8 s | yes |
| Model-delivered response latency p95 (live, realistic arrivals, n=15; informational) | 7.47 s | — | — |
| Unavailable rate (live), realistic arrivals, n=30 | 33.3% (10/30) [19.2%–51.2%] | ≤ 5% | no |
| Time to any response p95 (live), stress burst, n=30; informational | 7.53 s | — | — |
| Model-delivered response latency p95 (live, stress burst, n=14; informational) | 7.05 s | — | — |
| Unavailable rate (live), stress burst, n=30; informational | 36.7% (11/30) [21.9%–54.5%] | — | — |

## Judge

- Correct among answered: 93.0% (40/43) [81.4%–97.6%]; unsupported claims total: 0; completeness mean: 1.77 / 2.
- Appropriate among non-answered: 85.7% (24/28) [68.5%–94.3%].
  - expected answer: 0.0% (0/4) [0.0%–49.0%]
  - expected abstain: 100.0% (13/13) [77.2%–100.0%]
  - expected handoff: 100.0% (4/4) [51.0%–100.0%]
  - expected decline: 100.0% (7/7) [64.6%–100.0%]

## Code metrics

- Questions: 71; generation requests: 73; model calls: 66.
- Behavior accuracy: 93.0% (66/71) [84.6%–97.0%].
  - answer: 91.1% (41/45) [79.3%–96.5%]
  - abstain: 92.9% (13/14) [68.5%–98.7%]
  - handoff: 100.0% (4/4) [51.0%–100.0%]
  - decline: 100.0% (8/8) [67.6%–100.0%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 131 citations): document 96.9% (127/131) [92.4%–98.8%]; section 92.4% (121/131) [86.5%–95.8%].
- Quotes verified: 98.1% (152/155) [94.5%–99.3%]; invalid by reason: {"quote_too_short":3}.
- Removed sentences: failed citation 3, unmarked claim 6; downgraded to insufficient (no valid citation): 1; invalid output: 1.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (eval: excl. queue wait; live: time to any response, incl. queue wait) all: p50 3.26 s, p95 10.59 s, max 17.26 s; model calls only: p50 3.54 s, p95 10.61 s; model calls without retries (n=59): p95 5.81 s; model-delivered responses (n=66): p95 10.61 s. Answers that needed retries: 7. Queue wait total 166.0 s.
- Tokens per model call (mean): prompt 3273, output 249, thoughts 0.
- Availability: unavailable 0.0% (0/71) [0.0%–5.1%]; answered by {"gemini-3.5-flash-lite":66}; hops {"0":66}; attempts by model/status {"gemini-3.5-flash-lite":{"200":66,"503":7}}; retrieval fallback {"vector":71}.
- Quote words: all min 2 / p25 11 / median 16 / p75 22 / max 50 (n=155); valid min 3 / p25 12 / median 17 / p75 22 / max 50 (n=152); >40 words: 4, >80 words: 0.
- Equivalent cost at list price: $0.001496 per conversation, $0.1062 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 41 | 4 | 0 | 0 | 0 |
| abstain | 1 | 13 | 0 | 0 | 0 |
| handoff | 0 | 0 | 4 | 0 | 0 |
| decline | 1 | 0 | 0 | 7 | 0 |

