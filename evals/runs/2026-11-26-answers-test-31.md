# Answers run (test, test-31)

- Created: 2026-11-26T21:02:24.870Z
- Mode: eval; prompt: v4; model gemini-3.1-flash-lite

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
