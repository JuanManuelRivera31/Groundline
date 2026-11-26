# Answers run (test, test-35)

- Created: 2026-11-26T20:46:28.849Z
- Mode: eval; prompt: v4; model gemini-3.5-flash-lite

- Questions: 120; generation requests: 115; model calls: 113.
- Behavior accuracy: 94.2% (113/120) [88.4%–97.1%].
  - answer: 94.1% (80/85) [87.0%–97.5%]
  - abstain: 100.0% (19/19) [83.2%–100.0%]
  - handoff: 100.0% (6/6) [61.0%–100.0%]
  - decline: 80.0% (8/10) [49.0%–94.3%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 216 citations): document 86.1% (186/216) [80.9%–90.1%]; section 84.3% (182/216) [78.8%–88.5%].
- Quotes verified: 98.3% (230/234) [95.7%–99.3%]; invalid by reason: {"quote_not_found":2,"quote_too_long":2}.
- Removed sentences: failed citation 5, unmarked claim 7; downgraded to insufficient (no valid citation): 2; invalid output: 1.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":2}.
- Latency (eval: excl. queue wait; live: time to any response, incl. queue wait) all: p50 1.31 s, p95 2.34 s, max 15.43 s; model calls only: p50 1.35 s, p95 2.34 s; model calls without retries (n=112): p95 2.31 s; model-delivered responses (n=113): p95 2.34 s; query embedding (n=120): p50 0.25 s, p95 0.32 s. Answers that needed retries: 1. Queue wait total 490.7 s.
- Tokens per model call (mean): prompt 3219, output 229, thoughts 0.
- Availability: unavailable 0.0% (0/120) [0.0%–3.1%]; answered by {"gemini-3.5-flash-lite":113}; hops {"0":113}; hedged 0 (answered by {}); attempts by model/status {"gemini-3.5-flash-lite":{"200":113,"503":2}}; retrieval fallback {"vector":120}.
- Quote words: all min 3 / p25 11 / median 16 / p75 22 / max 109 (n=234); valid min 3 / p25 11 / median 16 / p75 22 / max 49 (n=230); >40 words: 11, >80 words: 2.
- Equivalent cost at list price: $0.001452 per conversation, $0.1743 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 80 | 4 | 1 | 0 | 0 |
| abstain | 0 | 19 | 0 | 0 | 0 |
| handoff | 0 | 0 | 6 | 0 | 0 |
| decline | 1 | 2 | 0 | 7 | 0 |
