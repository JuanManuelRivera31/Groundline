# Answers run (dev, v2-live)

- Created: 2026-11-24T20:15:27.832Z
- Mode: live; prompt: v2; model chain gemini-3.5-flash-lite → gemini-3.1-flash-lite

- Questions: 12; generation requests: 15; model calls: 10.
- Behavior accuracy: 100.0% (12/12) [75.8%–100.0%].
  - answer: 100.0% (9/9) [70.1%–100.0%]
  - abstain: 100.0% (2/2) [34.2%–100.0%]
  - handoff: 100.0% (1/1) [20.7%–100.0%]
  - decline: 0.0% (0/0) [0.0%–0.0%]
- Wrapped injections answered with citations: 0.
- Citation precision (answered answer-questions, 20 citations): document 90.0% (18/20) [69.9%–97.2%]; section 90.0% (18/20) [69.9%–97.2%].
- Quotes verified: 100.0% (23/23) [85.7%–100.0%]; invalid by reason: {}.
- Removed sentences: failed citation 0, unmarked claim 0; downgraded to insufficient (no valid citation): 0; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":2,"handoff":0,"decline":0}.
- Latency (excl. queue wait) all: p50 2.55 s, p95 5.52 s, max 5.63 s; model calls only: p50 3.91 s, p95 5.54 s; model calls without retries (n=5): p95 4.44 s. Answers that needed retries: 5. Queue wait total 0.0 s.
- Tokens per model call (mean): prompt 2766, output 238, thoughts 0.
- Availability: unavailable 0.0% (0/12) [0.0%–24.2%]; answered by {"gemini-3.5-flash-lite":5,"gemini-3.1-flash-lite":5}; hops {"0":5,"1":5}; attempts by model/status {"gemini-3.5-flash-lite":{"200":5,"503":5},"gemini-3.1-flash-lite":{"200":5}}; retrieval fallback {"vector":12}.
- Quote words: all min 6 / p25 15.5 / median 21 / p75 30.5 / max 45 (n=23); valid min 6 / p25 15.5 / median 21 / p75 30.5 / max 45 (n=23); >40 words: 2, >80 words: 0.
- Equivalent cost at list price: n/a (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 9 | 0 | 0 | 0 | 0 |
| abstain | 0 | 2 | 0 | 0 | 0 |
| handoff | 0 | 0 | 1 | 0 | 0 |
| decline | 0 | 0 | 0 | 0 | 0 |
