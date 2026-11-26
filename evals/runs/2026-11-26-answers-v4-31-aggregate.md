# Aggregate: evals/runs/2026-11-26-answers-v4-31.json

- Kind: answers; judged items: 71 (8 batch files); judge: claude-sonnet.

## Targets

| Metric | Value [Wilson 95%] | Target | Met |
| --- | --- | --- | --- |
| Fabricated answers (answered with unsupported claims) | 0.0% (0/48) [0.0%–7.4%] | ≤ 5% | yes |
| Correct "I don't know" on abstain questions | 85.7% (12/14) [60.1%–96.0%] | ≥ 90% | no |
| Correct answers on answer questions | 93.3% (42/45) [82.1%–97.7%] | ≥ 85% | yes |
| Citations to the correct source (document level) | 85.9% (122/142) [79.2%–90.7%] | ≥ 90% | no |
| Model latency p95 (eval mode, no retries; informational) | 3.70 s | — | — |
| Time to any response p95 (live), realistic arrivals, n=30 | 7.53 s | ≤ 8 s | yes |
| Model-delivered response latency p95 (live, realistic arrivals, n=15; informational) | 7.47 s | — | — |
| Unavailable rate (live), realistic arrivals, n=30 | 33.3% (10/30) [19.2%–51.2%] | ≤ 5% | no |
| Time to any response p95 (live), stress burst, n=30; informational | 7.53 s | — | — |
| Model-delivered response latency p95 (live, stress burst, n=14; informational) | 7.05 s | — | — |
| Unavailable rate (live), stress burst, n=30; informational | 36.7% (11/30) [21.9%–54.5%] | — | — |

## Judge

- Correct among answered: 89.6% (43/48) [77.8%–95.5%]; unsupported claims total: 0; completeness mean: 1.83 / 2.
- Appropriate among non-answered: 95.7% (22/23) [79.0%–99.2%].
  - expected answer: 0.0% (0/1) [0.0%–79.3%]
  - expected abstain: 100.0% (12/12) [75.8%–100.0%]
  - expected handoff: 100.0% (3/3) [43.9%–100.0%]
  - expected decline: 100.0% (7/7) [64.6%–100.0%]

## Code metrics

- Questions: 71; generation requests: 66; model calls: 66.
- Behavior accuracy: 94.4% (67/71) [86.4%–97.8%].
  - answer: 97.8% (44/45) [88.4%–99.6%]
  - abstain: 85.7% (12/14) [60.1%–96.0%]
  - handoff: 75.0% (3/4) [30.1%–95.4%]
  - decline: 100.0% (8/8) [67.6%–100.0%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 142 citations): document 85.9% (122/142) [79.2%–90.7%]; section 78.2% (111/142) [70.7%–84.2%].
- Quotes verified: 98.8% (164/166) [95.7%–99.7%]; invalid by reason: {"quote_not_found":2}.
- Removed sentences: failed citation 0, unmarked claim 23; downgraded to insufficient (no valid citation): 0; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (eval: excl. queue wait; live: time to any response, incl. queue wait) all: p50 1.16 s, p95 3.57 s, max 5.01 s; model calls only: p50 1.21 s, p95 3.70 s; model calls without retries (n=66): p95 3.70 s; model-delivered responses (n=66): p95 3.70 s. Answers that needed retries: 0. Queue wait total 279.7 s.
- Tokens per model call (mean): prompt 3273, output 252, thoughts 0.
- Availability: unavailable 0.0% (0/71) [0.0%–5.1%]; answered by {"gemini-3.1-flash-lite":66}; hops {"0":66}; attempts by model/status {"gemini-3.1-flash-lite":{"200":66}}; retrieval fallback {"vector":71}.
- Quote words: all min 4 / p25 13 / median 18 / p75 26.75 / max 63 (n=166); valid min 4 / p25 13 / median 18 / p75 26.25 / max 63 (n=164); >40 words: 10, >80 words: 0.
- Equivalent cost at list price: $0.001116 per conversation, $0.0792 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 44 | 1 | 0 | 0 | 0 |
| abstain | 2 | 12 | 0 | 0 | 0 |
| handoff | 1 | 0 | 3 | 0 | 0 |
| decline | 1 | 0 | 0 | 7 | 0 |

