# Answers run (dev, v4-live)

- Created: 2026-11-26T04:25:41.562Z
- Mode: live; prompt: v4; model chain gemini-3.5-flash-lite → gemini-3.1-flash-lite

- Questions: 30; generation requests: 31; model calls: 25.
- Behavior accuracy: 66.7% (20/30) [48.8%–80.8%].
  - answer: 52.6% (10/19) [31.7%–72.7%]
  - abstain: 87.5% (7/8) [52.9%–97.8%]
  - handoff: 100.0% (3/3) [43.9%–100.0%]
  - decline: 0.0% (0/0) [0.0%–0.0%]
- Wrapped injections answered with citations: 0.
- Citation precision (answered answer-questions, 27 citations): document 81.5% (22/27) [63.3%–91.8%]; section 81.5% (22/27) [63.3%–91.8%].
- Quotes verified: 100.0% (42/42) [91.6%–100.0%]; invalid by reason: {}.
- Removed sentences: failed citation 0, unmarked claim 1; downgraded to insufficient (no valid citation): 0; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (eval: excl. queue wait; live: time to any response, incl. queue wait) all: p50 3.43 s, p95 7.53 s, max 7.54 s; model calls only: p50 6.47 s, p95 7.54 s; model calls without retries (n=19): p95 7.54 s; model-delivered responses (n=15): p95 7.47 s. Answers that needed retries: 6. Queue wait total 0.0 s.
- Tokens per model call (mean): prompt 1956, output 159, thoughts 0.
- Availability: unavailable 33.3% (10/30) [19.2%–51.2%]; answered by {"gemini-3.1-flash-lite":3,"gemini-3.5-flash-lite":12}; hops {"0":19,"1":6}; attempts by model/status {"gemini-3.5-flash-lite":{"0":7,"200":12,"503":6},"gemini-3.1-flash-lite":{"0":3,"200":3,"local:budget":7}}; retrieval fallback {"vector":30}.
- Quote words: all min 4 / p25 10.75 / median 16 / p75 24 / max 43 (n=40); valid min 4 / p25 10.75 / median 16 / p75 24 / max 43 (n=40); >40 words: 2, >80 words: 0.
- Equivalent cost at list price: $0.000774 per conversation, $0.0232 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 10 | 0 | 0 | 0 | 9 |
| abstain | 0 | 7 | 0 | 0 | 1 |
| handoff | 0 | 0 | 3 | 0 | 0 |
| decline | 0 | 0 | 0 | 0 | 0 |
