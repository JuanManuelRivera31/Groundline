# Answers run (dev, v3-live)

- Created: 2026-11-24T21:47:35.457Z
- Mode: live; prompt: v3; model chain gemini-3.5-flash-lite → gemini-3.1-flash-lite

- Questions: 30; generation requests: 31; model calls: 25.
- Behavior accuracy: 76.7% (23/30) [59.1%–88.2%].
  - answer: 78.9% (15/19) [56.7%–91.5%]
  - abstain: 87.5% (7/8) [52.9%–97.8%]
  - handoff: 33.3% (1/3) [6.1%–79.2%]
  - decline: 0.0% (0/0) [0.0%–0.0%]
- Wrapped injections answered with citations: 0.
- Citation precision (answered answer-questions, 43 citations): document 79.1% (34/43) [64.8%–88.6%]; section 76.7% (33/43) [62.3%–86.8%].
- Quotes verified: 100.0% (47/47) [92.4%–100.0%]; invalid by reason: {}.
- Removed sentences: failed citation 0, unmarked claim 1; downgraded to insufficient (no valid citation): 0; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (excl. queue wait) all: p50 1.64 s, p95 8.02 s, max 8.02 s; model calls only: p50 2.73 s, p95 8.02 s; model calls without retries (n=19): p95 8.02 s. Answers that needed retries: 6. Queue wait total 10.0 s.
- Tokens per model call (mean): prompt 2302, output 200, thoughts 0.
- Availability: unavailable 20.0% (6/30) [9.5%–37.3%]; answered by {"gemini-3.1-flash-lite":7,"gemini-3.5-flash-lite":12}; hops {"0":13,"1":12}; attempts by model/status {"gemini-3.5-flash-lite":{"0":1,"200":12,"503":6,"local:rate_local":6},"gemini-3.1-flash-lite":{"0":3,"200":7,"503":2,"local:budget":1}}; retrieval fallback {"vector":30}.
- Quote words: all min 6 / p25 14.5 / median 18 / p75 23 / max 50 (n=47); valid min 6 / p25 14.5 / median 18 / p75 23 / max 50 (n=47); >40 words: 3, >80 words: 0.
- Equivalent cost at list price: $0.000900 per conversation, $0.0270 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 15 | 0 | 0 | 0 | 4 |
| abstain | 0 | 7 | 0 | 0 | 1 |
| handoff | 1 | 0 | 1 | 0 | 1 |
| decline | 0 | 0 | 0 | 0 | 0 |
