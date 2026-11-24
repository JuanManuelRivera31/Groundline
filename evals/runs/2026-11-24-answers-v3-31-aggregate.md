# Aggregate: evals/runs/2026-11-24-answers-v3-31.json

- Kind: answers; judged items: 71 (8 batch files); judge: claude-sonnet.

## Targets

| Metric | Value [Wilson 95%] | Target | Met |
| --- | --- | --- | --- |
| Fabricated answers (answered with unsupported claims) | 2.3% (1/44) [0.4%–11.8%] | ≤ 5% | yes |
| Correct "I don't know" on abstain questions | 100.0% (14/14) [78.5%–100.0%] | ≥ 90% | yes |
| Correct answers on answer questions | 84.4% (38/45) [71.2%–92.3%] | ≥ 85% | no |
| Citations to the correct source (document level) | 85.0% (91/107) [77.1%–90.6%] | ≥ 90% | no |
| Model latency p95 (eval mode, no retries; informational) | 7.42 s | — | — |
| Latency p95 (live mode), n=30 | 8.02 s | ≤ 8 s | no |

## Judge

- Correct among answered: 88.6% (39/44) [76.0%–95.0%]; unsupported claims total: 1; completeness mean: 1.75 / 2.
- Appropriate among non-answered: 88.9% (24/27) [71.9%–96.1%].
  - expected answer: 0.0% (0/3) [0.0%–56.1%]
  - expected abstain: 100.0% (14/14) [78.5%–100.0%]
  - expected handoff: 100.0% (3/3) [43.9%–100.0%]
  - expected decline: 100.0% (7/7) [64.6%–100.0%]

## Code metrics

- Questions: 71; generation requests: 69; model calls: 66.
- Behavior accuracy: 94.4% (67/71) [86.4%–97.8%].
  - answer: 93.3% (42/45) [82.1%–97.7%]
  - abstain: 100.0% (14/14) [78.5%–100.0%]
  - handoff: 75.0% (3/4) [30.1%–95.4%]
  - decline: 100.0% (8/8) [67.6%–100.0%]
- Wrapped injections answered with citations: 1.
- Citation precision (answered answer-questions, 107 citations): document 85.0% (91/107) [77.1%–90.6%]; section 81.3% (87/107) [72.9%–87.6%].
- Quotes verified: 97.6% (121/124) [93.1%–99.2%]; invalid by reason: {"quote_not_found":3}.
- Removed sentences: failed citation 1, unmarked claim 8; downgraded to insufficient (no valid citation): 1; invalid output: 0.
- Floor hits by expected behavior: {"answer":0,"abstain":5,"handoff":0,"decline":0}.
- Latency (excl. queue wait) all: p50 2.21 s, p95 8.74 s, max 102.03 s; model calls only: p50 2.40 s, p95 8.91 s; model calls without retries (n=64): p95 7.42 s. Answers that needed retries: 2. Queue wait total 164.4 s.
- Tokens per model call (mean): prompt 3032, output 216, thoughts 0.
- Availability: unavailable 0.0% (0/71) [0.0%–5.1%]; answered by {"gemini-3.1-flash-lite":66}; hops {"0":66}; attempts by model/status {"gemini-3.1-flash-lite":{"200":66,"503":3}}; retrieval fallback {"vector":71}.
- Quote words: all min 8 / p25 17 / median 22 / p75 30 / max 55 (n=124); valid min 8 / p25 17 / median 22 / p75 30 / max 52 (n=121); >40 words: 12, >80 words: 0.
- Equivalent cost at list price: $0.001009 per conversation, $0.0716 total (free tier: $0).

### Expected behavior × status

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer | 42 | 2 | 1 | 0 | 0 |
| abstain | 0 | 14 | 0 | 0 | 0 |
| handoff | 1 | 0 | 3 | 0 | 0 |
| decline | 1 | 0 | 0 | 7 | 0 |

