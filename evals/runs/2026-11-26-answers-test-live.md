# Answers run (test, test-live)

- Created: 2026-11-26T21:11:34.205Z
- Mode: live; prompt: v4; model chain gemini-3.5-flash-lite → gemini-3.1-flash-lite

- Questions: 30; generation requests: 32; model calls: 29.
- Behavior accuracy: 100.0% (30/30) [88.6%–100.0%].
  - answer: 100.0% (21/21) [84.5%–100.0%]
  - abstain: 100.0% (4/4) [51.0%–100.0%]
  - handoff: 100.0% (1/1) [20.7%–100.0%]
  - decline: 100.0% (4/4) [51.0%–100.0%]
- Wrapped injections answered with citations: 0.
- Citation precision (answered answer-questions, 66 citations): document 84.8% (56/66) [74.3%–91.6%]; section 84.8% (56/66) [74.3%–91.6%].
- Quotes verified: 98.5% (67/68) [92.1%–99.7%]; invalid by reason: {"quote_too_short":1}.
- Removed sentences: failed citation 0, unmarked claim 3; downgraded to insufficient (no valid citation): 0; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":1,"handoff":0,"decline":0}.
- Latency (eval: excl. queue wait; live: time to any response, incl. queue wait) all: p50 1.53 s, p95 4.76 s, max 4.85 s; model calls only: p50 1.57 s, p95 4.76 s; model calls without retries (n=26): p95 2.93 s; model-delivered responses (n=29): p95 4.76 s; query embedding (n=30): p50 0.39 s, p95 0.57 s. Answers that needed retries: 3. Queue wait total 0.0 s.
- Tokens per model call (mean): prompt 3349, output 226, thoughts 0.
- Availability: unavailable 0.0% (0/30) [0.0%–11.4%]; answered by {"gemini-3.5-flash-lite":28,"gemini-3.1-flash-lite":1}; hops {"0":26,"1":3}; hedged 3 (answered by {"gemini-3.5-flash-lite":2,"gemini-3.1-flash-lite":1}); attempts by model/status {"gemini-3.5-flash-lite":{"200":28,"cancelled":1},"gemini-3.1-flash-lite":{"200":1,"cancelled":2}}; retrieval fallback {"vector":30}.
- Quote words: all min 1 / p25 11 / median 16 / p75 22 / max 43 (n=68); valid min 5 / p25 11.5 / median 16 / p75 22 / max 43 (n=67); >40 words: 1, >80 words: 0.
- Equivalent cost at list price: $0.001505 per conversation, $0.0452 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 21 | 0 | 0 | 0 | 0 |
| abstain | 0 | 4 | 0 | 0 | 0 |
| handoff | 0 | 0 | 1 | 0 | 0 |
| decline | 0 | 0 | 0 | 4 | 0 |
