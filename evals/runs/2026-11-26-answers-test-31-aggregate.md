# Aggregate: evals/runs/2026-11-26-answers-test-31.json

- Kind: answers; judged items: 120 (12 batch files); judge: claude-sonnet.

## Targets

| Metric | Value [Wilson 95%] | Target | Met |
| --- | --- | --- | --- |
| Fabricated answers (answered with unsupported claims) | 2.3% (2/86) [0.6%–8.1%] | ≤ 5% | yes |
| Correct "I don't know" on abstain questions | 89.5% (17/19) [68.6%–97.1%] | ≥ 90% | no |
| Correct answers on answer questions | 90.6% (77/85) [82.5%–95.2%] | ≥ 85% | yes |
| Citations to the correct source (document level) | 81.8% (189/231) [76.3%–86.3%] | ≥ 90% | no |
| Model latency p95 (eval mode, no retries; informational) | 15.01 s | — | — |
| Time to any response p95 (live), realistic arrivals, n=30 | 4.76 s | ≤ 8 s | yes |
| Model-delivered response latency p95 (live, realistic arrivals, n=29; informational) | 4.76 s | — | — |
| Unavailable rate (live), realistic arrivals, n=30 | 0.0% (0/30) [0.0%–11.4%] | ≤ 5% | yes |
| Query embedding latency p95 (live, realistic arrivals, n=30; informational) | 0.57 s | — | — |

## Judge

- Correct among answered: 90.7% (78/86) [82.7%–95.2%]; unsupported claims total: 2; completeness mean: 1.81 / 2.
- Appropriate among non-answered: 82.4% (28/34) [66.5%–91.7%].
  - expected answer: 0.0% (0/4) [0.0%–49.0%]
  - expected abstain: 100.0% (17/17) [81.6%–100.0%]
  - expected handoff: 100.0% (4/4) [51.0%–100.0%]
  - expected decline: 77.8% (7/9) [45.3%–93.7%]

## Code metrics

- Questions: 120; generation requests: 127; model calls: 113.
- Behavior accuracy: 91.7% (110/120) [85.3%–95.4%].
  - answer: 95.3% (81/85) [88.5%–98.2%]
  - abstain: 89.5% (17/19) [68.6%–97.1%]
  - handoff: 66.7% (4/6) [30.0%–90.3%]
  - decline: 80.0% (8/10) [49.0%–94.3%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 231 citations): document 81.8% (189/231) [76.3%–86.3%]; section 79.2% (183/231) [73.5%–84.0%].
- Quotes verified: 99.6% (261/262) [97.9%–99.9%]; invalid by reason: {"quote_not_found":1}.
- Removed sentences: failed citation 0, unmarked claim 17; downgraded to insufficient (no valid citation): 0; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":2}.
- Latency (eval: excl. queue wait; live: time to any response, incl. queue wait) all: p50 2.13 s, p95 16.35 s, max 71.22 s; model calls only: p50 2.19 s, p95 16.91 s; model calls without retries (n=102): p95 15.01 s; model-delivered responses (n=113): p95 16.91 s; query embedding (n=120): p50 0.00 s, p95 0.00 s. Answers that needed retries: 11. Queue wait total 275.5 s.
- Tokens per model call (mean): prompt 3219, output 236, thoughts 0.
- Availability: unavailable 0.0% (0/120) [0.0%–3.1%]; answered by {"gemini-3.1-flash-lite":113}; hops {"0":113}; hedged 0 (answered by {}); attempts by model/status {"gemini-3.1-flash-lite":{"200":113,"503":14}}; retrieval fallback {"vector":120}.
- Quote words: all min 4 / p25 13 / median 19 / p75 25 / max 72 (n=262); valid min 4 / p25 13 / median 19 / p75 25 / max 72 (n=261); >40 words: 14, >80 words: 0.
- Equivalent cost at list price: $0.001094 per conversation, $0.1313 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 81 | 1 | 3 | 0 | 0 |
| abstain | 2 | 17 | 0 | 0 | 0 |
| handoff | 2 | 0 | 4 | 0 | 0 |
| decline | 1 | 2 | 0 | 7 | 0 |

