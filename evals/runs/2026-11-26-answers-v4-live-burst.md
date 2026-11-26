# Answers run (dev, v4-live-burst)

- Created: 2026-11-26T04:28:10.125Z
- Mode: live; prompt: v4; model chain gemini-3.5-flash-lite → gemini-3.1-flash-lite

- Questions: 30; generation requests: 27; model calls: 25.
- Behavior accuracy: 60.0% (18/30) [42.3%–75.4%].
  - answer: 57.9% (11/19) [36.3%–76.9%]
  - abstain: 75.0% (6/8) [40.9%–92.9%]
  - handoff: 33.3% (1/3) [6.1%–79.2%]
  - decline: 0.0% (0/0) [0.0%–0.0%]
- Wrapped injections answered with citations: 0.
- Citation precision (answered answer-questions, 32 citations): document 87.5% (28/32) [71.9%–95.0%]; section 87.5% (28/32) [71.9%–95.0%].
- Quotes verified: 100.0% (36/36) [90.4%–100.0%]; invalid by reason: {}.
- Removed sentences: failed citation 0, unmarked claim 3; downgraded to insufficient (no valid citation): 0; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (eval: excl. queue wait; live: time to any response, incl. queue wait) all: p50 2.70 s, p95 7.53 s, max 7.54 s; model calls only: p50 6.89 s, p95 7.53 s; model calls without retries (n=23): p95 7.53 s; model-delivered responses (n=14): p95 7.05 s. Answers that needed retries: 2. Queue wait total 37.2 s.
- Tokens per model call (mean): prompt 1844, output 158, thoughts 0.
- Availability: unavailable 36.7% (11/30) [21.9%–54.5%]; answered by {"gemini-3.5-flash-lite":7,"gemini-3.1-flash-lite":7}; hops {"0":18,"1":7}; attempts by model/status {"gemini-3.5-flash-lite":{"0":11,"200":7,"503":2,"local:rate_local":5},"gemini-3.1-flash-lite":{"200":7,"local:budget":11}}; retrieval fallback {"vector":30}.
- Quote words: all min 5 / p25 16 / median 20.5 / p75 28.5 / max 50 (n=36); valid min 5 / p25 16 / median 20.5 / p75 28.5 / max 50 (n=36); >40 words: 4, >80 words: 0.
- Equivalent cost at list price: $0.000680 per conversation, $0.0204 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 11 | 0 | 0 | 0 | 8 |
| abstain | 1 | 6 | 0 | 0 | 1 |
| handoff | 0 | 0 | 1 | 0 | 2 |
| decline | 0 | 0 | 0 | 0 | 0 |
