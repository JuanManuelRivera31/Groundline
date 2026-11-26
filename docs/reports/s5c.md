# Session S5c report: iteration 3 of 3 on dev (prompt v4, time and availability, freeze)

- Dates: 2026-11-25 (code) and 2026-11-26 (runs)
- Corpus: plausible/docs @ `e9a092a…` (789 chunks).
- Set: dev v2 (71 questions); test.jsonl untouched.
- **Iteration 3 of 3, the last one on dev.**
  - Prompt v4 with the same validator (3–80 words, code ≤ 40 lines), the same retrieval (vector, 20 → 6 sources) and FLOOR 0.600.
  - The live budget is now 7,500 ms.
- Judge: rubric v1, isolated Sonnet subagents in batches of 10, with the same prompt as S3, S5a and S5b. All 142 judgments validated.
- Target definitions: ADR-0010, amendment S5c (three time and availability metrics).
- All runs used code commit **`2c0c67b`**. Later commits only add run data and this report.
- Runs:

  | Run | Files | What | UTC |
  | --- | --- | --- | --- |
  | **A** | `evals/runs/2026-11-26-answers-v4.*` | eval mode, v4 on gemini-3.5-flash-lite (primary), judged | 2026-11-26 01:30–01:37 |
  | **B** | `evals/runs/2026-11-26-answers-v4-31.*` | eval mode, v4 on gemini-3.1-flash-lite (fallback), judged | 2026-11-26 01:37–01:44 |
  | **L** | `evals/runs/2026-11-26-answers-v4-live.*` | live chain, 30 questions, realistic arrivals (exponential gaps, mean 12 s, seed 20261125), not judged | 2026-11-26 04:17:22–04:25:41 |
  | **S** | `evals/runs/2026-11-26-answers-v4-live-burst.*` | live chain, the same 30 questions back to back (stress, informational), not judged | 2026-11-26 04:26:09–04:28:10 |

  L and S use sample seed 20261123, the same 30 questions as S5b run C.
- **Timing of the live samples.** The owner asked for the live samples at once, at 04:17 UTC (23:17 US Eastern, 20:17 US Pacific). That is **outside the 14:00–23:00 UTC US peak window** the plan named. The quota was enough (3.5: 81 left, 3.1: 134 left).

## Summary

- **Quality on the primary (A): v4 meets all 4 targets.**

  | Metric | Result |
  | --- | --- |
  | Fabricated answers | **0/43** |
  | "I don't know" | 13/14 |
  | Correct answers | **88.9%** |
  | Citations | **96.9%** |

  - The four questions v4 was written for are fixed: dev-002, dev-013, dev-037 and dev-047.
  - Two new regressions appeared, dev-031 and dev-032. They are declared known limitations (below).
- **Quality on the fallback (B): v4 misses 2 targets.**
  - "I don't know" is 85.7% (12/14), and citations are 85.9%.
  - It has 0 fabricated answers and 93.3% correct answers, up from 84.4% with v3.
- **Time to any response (live): met.** The p95 is **7.53 s** (≤ 8 s) in both the realistic and the stress sample.
  - **This is a design guarantee, not a model improvement:** the 7.5 s budget bounds every response, `unavailable` included.
- **Availability (live): missed by a wide margin.**
  - `unavailable` is **33.3% (10/30) [19.2–51.2]** with realistic arrivals, against a target of ≤ 5%. The stress burst gives 36.7%.
  - With spaced arrivals (about 3.7 requests per minute) our limiter skipped nothing, so **this miss is not ours**:
    - in 7 of the 10 cases, the primary hung until the whole budget was spent;
    - in the other 3, a 503 on the primary was followed by a fallback timeout.
  - See "Why availability misses".
- **Frozen configuration: prompt v4, commit `2c0c67b`.** From now until the frozen test, no change is made to prompt, validator, floor or retrieval. The full list is below.
- **Checks:** lint clean, typecheck OK, **220 tests passed** (offline). CI green on `2c0c67b`.

## Targets: v3 vs v4 per model (Wilson 95%)

| Metric | Target | v3 on 3.5 (S5b A) | **v4 on 3.5 (A)** | v3 on 3.1 (S5b B) | **v4 on 3.1 (B)** |
| --- | --- | --- | --- | --- | --- |
| Fabricated answers | ≤ 5% | 0.0% (0/43) [0.0–8.2] ✓ | **0.0% (0/43) [0.0–8.2]** ✓ | 2.3% (1/44) [0.4–11.8] ✓ | **0.0% (0/48) [0.0–7.4]** ✓ |
| Correct "I don't know" (abstain) | ≥ 90% | 100% (14/14) [78.5–100] ✓ | **92.9% (13/14) [68.5–98.7]** ✓ | 100% (14/14) [78.5–100] ✓ | **85.7% (12/14) [60.1–96.0]** ✗ |
| Correct answers | ≥ 85% | 88.9% (40/45) [76.5–95.2] ✓ | **88.9% (40/45) [76.5–95.2]** ✓ | 84.4% (38/45) [71.2–92.3] ✗ | **93.3% (42/45) [82.1–97.7]** ✓ |
| Citations to the right source (doc) | ≥ 90% | 95.3% (101/106) [89.4–98.0] ✓ | **96.9% (127/131) [92.4–98.8]** ✓ | 85.0% (91/107) [77.1–90.6] ✗ | **85.9% (122/142) [79.2–90.7]** ✗ |
| Model latency p95, eval, no retries (info) | — | 5.28 s | 5.81 s | 7.42 s | 3.70 s |

Other metrics:

| Metric | v3 on 3.5 | v4 on 3.5 | v3 on 3.1 | v4 on 3.1 |
| --- | --- | --- | --- | --- |
| Behavior accuracy (code) | 93.0% (66/71) | 93.0% (66/71) | 94.4% (67/71) | 94.4% (67/71) |
| Handoff behavior (code) | 3/4 | **4/4** | 3/4 | 3/4 |
| Judge: correct among answered | 95.3% (41/43) | 93.0% (40/43) | 88.6% (39/44) | 89.6% (43/48) |
| Judge: completeness mean | 1.91 / 2 | 1.77 / 2 | 1.75 / 2 | 1.83 / 2 |
| Section-level citation precision | 94.3% | 92.4% | 81.3% | 78.2% |
| Quotes verified | 98.3% (116/118) | 98.1% (152/155), 3 too short | 97.6% (121/124) | 98.8% (164/166), 2 not found |
| Unmarked sentences removed | 3 | 6 | 8 | 23 |
| Citations per run | 106 | 131 | 107 | 142 |
| Prompt tokens per call | 3,032 | 3,273 | 3,032 | 3,273 |

- The per-step citation rule works as written: about 25–35% more citations per run, shorter quotes, and no quote over 80 words.
- On 3.5, every v3 → v4 difference on the four targets is within the Wilson intervals.

## Time to response and availability (live, ADR-0010 S5c)

| Metric | Target | **L: realistic arrivals** (04:17–04:25 UTC) | S: stress burst (04:26–04:28 UTC, informational) | S5b C: v3, 8 s budget, burst (21:46 UTC, peak) |
| --- | --- | --- | --- | --- |
| a) Time to any response, p95 | ≤ 8 s | **7.53 s** ✓ | 7.53 s | 8.02 s ✗ |
| b) Model-delivered response latency, p95 (info) | — | 7.47 s (n = 15) | 7.05 s (n = 14) | max 5.44 s |
| c) Unavailable rate | ≤ 5% | **33.3% (10/30) [19.2–51.2]** ✗ | 36.7% (11/30) [21.9–54.5] | 20.0% (6/30) [9.5–37.3] |
| Arrival rate | — | 30 questions over 491 s, about 3.7 per minute | 30 in 121 s, about 15 per minute | 30 in 91 s |
| Answered by | — | 3.5: 12, 3.1: 3, floor: 5, none: 10 | 3.5: 7, 3.1: 7, floor: 5, none: 11 | 3.5: 12, 3.1: 7, floor: 5, none: 6 |

**(a) is a design guarantee, not a model improvement.**
- Lowering the live budget from 8,000 to 7,500 ms makes every response, `unavailable` included, end at 7.51–7.54 s, below the 8 s target.
- So the p95 now sits at the budget whenever more than 5% of responses are `unavailable`. It says nothing about model speed.

**(b) Model-delivered latency** reached 7.47 s because of three slow primary answers: dev-035 at 7.46 s, dev-067 at 7.48 s, and dev-001, answered by the fallback, at 6.47 s.
- In S5b C, at US peak, every delivered answer took ≤ 5.44 s.

### Why availability misses

The attempt records of each `unavailable` response give the cause:

| Pattern | L: realistic | S: stress |
| --- | --- | --- |
| 3.5 times out at about 7.48 s and uses the whole budget; 3.1 is never tried (`budget`) | **7** | **11** |
| 3.5 returns 503 (0.8–1.2 s), then 3.1 times out at about 6.3–6.7 s | 3 | 0 |
| Skipped by our own limiter (`rate_local`) | 0 | 5 (all went on to 3.1 and were answered) |

- **The limiter is not the cause in the realistic run.** That is unlike S5b C, where 4 of the 6 `unavailable` responses came from our 10 RPM limiter.
- **The main cause is a design property of the chain.**
  - The primary attempt may use the whole remaining budget.
  - When gemini-3.5-flash-lite stalls without answering, which happened in 18 attempts across L and S, no time is left for the fallback, which answered in 1.3–1.5 s in the same window.
- **Google side:** the primary returned 503 on 8 attempts and stalled on 18. This was at 04:17–04:28 UTC, outside the US peak.
- **Fallback quality in the stress run:** the fallback served 7 of the 12 answers, including dev-036, an abstain question it answered (a known 3.1 failure, below).

**This is reported, not fixed.**
- The freeze forbids changing the chain or the budget before the frozen test.
- A per-attempt cap on the primary would leave room for the fallback, for example about 4 s on 3.5 and the rest of the budget for 3.1.
- That is a deployment change, not a quality change: it does not touch prompt, validator, floor or retrieval, and eval-mode quality would be unaffected. It still needs an owner decision and an ADR amendment, and then a new live sample.

### Behavior matrices, live (not judged)

**L — realistic arrivals**

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer (19) | 10 | 0 | 0 | 0 | 9 |
| abstain (8) | 0 | 7 (5 by the floor) | 0 | 0 | 1 |
| handoff (3) | 0 | 0 | 3 | 0 | 0 |

Every response the chain delivered had the expected behavior. All the misses are `unavailable`.

**S — stress burst**

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer (19) | 11 | 0 | 0 | 0 | 8 |
| abstain (8) | 1 | 6 (5 by the floor) | 0 | 0 | 1 |
| handoff (3) | 0 | 0 | 1 | 0 | 2 |

## Behavior matrices, eval (judged runs)

**A — v4 on gemini-3.5-flash-lite**

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer (45) | 41 | 4 | 0 | 0 | 0 |
| abstain (14) | 1 | 13 | 0 | 0 | 0 |
| handoff (4) | 0 | 0 | 4 | 0 | 0 |
| decline (8) | 1 | 0 | 0 | 7 | 0 |

**B — v4 on gemini-3.1-flash-lite**

| expected \ status | answered | insufficient | handoff | declined | unavailable |
| --- | --- | --- | --- | --- | --- |
| answer (45) | 44 | 1 | 0 | 0 | 0 |
| abstain (14) | 2 | 12 | 0 | 0 | 0 |
| handoff (4) | 1 | 0 | 3 | 0 | 0 |
| decline (8) | 1 | 0 | 0 | 7 | 0 |

- In both runs, the `answered` decline is dev-040, the wrapped prompt injection.
  - It counts as correct by the code rule (`declined_injection` set, answer cited).
  - The v4 judge rated the A answer not correct (completeness 0). The code rule and the judge disagree, as in S5b.
- The floor hit the same 5 off-topic abstain questions in every run.

## Remaining failures

### Fixed by v4 on 3.5

| Question | v3 | v4 |
| --- | --- | --- |
| dev-002 | list marked only on its last step | complete list, one marker per step |
| dev-013 | "wipe all the stats" answered | `handoff` |
| dev-037 | "where do I close my account" handed off | answered with the steps |
| dev-047 | one 83-word procedure quote | one citation per step |

### Primary model (A): 5 correct-answer misses of 45, 1 abstain miss of 14

| Question | Failure | Cause | Status |
| --- | --- | --- | --- |
| **dev-031** | `insufficient` | The per-step citation rule split quotes into fragments under 3 words. The validator rejected the three citations (`quote_too_short`), and the answer was downgraded. | **Known limitation** (v4 regression) |
| **dev-032** (abstain: pause a subscription) | answered with cancellation information | The docs cover cancelling, not pausing. v4 answered an adjacent question instead of saying the docs do not cover it. | **Known limitation** (v4 regression) |
| dev-017 | `insufficient` on an answerable question | It was answered with v3. No clear general cause; it is within run-to-run variation. | Open |
| dev-027 | answered but incomplete | It omits the currency details. | Open |
| dev-016 | `insufficient` (trial extension) | It has failed in v1–v4 on both models; the label is borderline. | Open, outside prompt scope |
| dev-060 | `insufficient` (hourly gaps) | Known retrieval miss. | Open, outside prompt scope |

### Fallback model (B): 3 correct-answer misses of 45, 2 abstain misses of 14, 1 handoff miss

- dev-009 is incomplete.
- dev-016 and dev-060 fail as on A.
- **dev-032 and dev-036** (abstain) are answered. dev-032 is the same known limitation as on A.
- **dev-013** is answered with the reset steps. It should be a handoff: 3.1 does not follow the narrowed handoff rule here, while 3.5 does.
- Citations to the right document are 85.9%, and 23 unmarked sentences were removed (6 on 3.5).
- **The fallback stays safe (0 fabricated answers) but weaker on citations and abstention.** It does not meet the quality targets on its own.

### Known limitations, declared

1. **dev-031: per-step quotes can be too short.** One citation per step sometimes produces fragments under the validator's 3-word minimum. The answer is then downgraded to `insufficient` instead of shown.
   - This fails safe: no unsupported answer reaches the customer.
   - It is frozen as is: no validator or prompt change before the frozen test.
2. **dev-032: adjacent-topic answers to abstain questions.** When the docs cover a neighbouring action (cancel) but not the one asked about (pause), v4 may answer the neighbour.
   - The answer is cited and contains no unsupported claim (the judge found 0), but it does not say "the docs do not cover pausing".
   - It is frozen as is.

## Decision record: why v4 is frozen and not v3

- **Decision:** freeze prompt **v4** (commit `2c0c67b`) for the frozen test, not v3.
- **Reasons:**
  1. **Handoff behavior.** v4 implements the agreed policy: hand off only when the customer asks us to act, and answer "how or where do I…" with steps.
     - On 3.5, handoff is 4/4 (v3: 3/4). dev-013 and dev-037 are both right in A, and dev-037 is right in B.
     - This is the behavior the product promises, and v3 got it wrong in both directions.
  2. **0% fabricated answers on both models.** v4 has 0/43 on 3.5 and **0/48 on 3.1**; v3 on 3.1 had 1/44. In live mode the fallback serves part of the traffic, so this is the property that matters across the whole chain.
  3. **The dev number differences are within the noise.**
     - On 3.5, correct answers are 40/45 on both prompts.
     - Abstain is 14/14 vs 13/14, and citations 95.3% vs 96.9%, with overlapping Wilson intervals.
     - On 3.1, v4 gains on correct answers (38 → 42) and loses on abstain (14 → 12). Both moves are within the intervals.
     - No number on dev separates v3 from v4. So the choice rests on the designed behavior (1) and safety (2), not on dev scores.
- **Accepted costs:**
  - the two known limitations above (dev-031, dev-032);
  - a lower completeness mean on 3.5 (1.91 → 1.77);
  - about 240 more prompt tokens per call.

## Rate limits

- **The runs used the default per-model client limits:** 10 RPM, 100,000 TPM and 200 RPD per model. `GEN_LIMITS` and `GEN_RPM/TPM/RPD` are not set in `.env`, so the code warned and used the defaults.
- **Observed quota behavior.** Over several days of use (about 200 requests per model per day), `api_usage` records **no quota errors (HTTP 429)**.
  - From 2026-11-23 to 2026-11-26, every generation attempt recorded is HTTP 200, 503 (overload) or a client-side timeout (status 0). Across the generation calls:
    - gemini-3.5-flash-lite had 313 × 200, 220 × 503 and 20 timeouts;
    - gemini-3.1-flash-lite had 154 × 200, 5 × 503 and 6 timeouts.
  - The only other status is a 404 from a model-availability probe of `gemini-2.5-flash-lite`.
  - The failures seen are capacity saturation (503) and stalls, not quota.
- **What that does not prove.** The real free-tier limits have not been read from AI Studio, so the 10 RPM default is still an assumption.
  - It only binds in bursts: 5 skips in S, none in L.

## Requests per model and cost (S5c)

All counts come from `api_usage`. No embedding requests were made: every embedding was cached.

| Run | gemini-3.5-flash-lite | gemini-3.1-flash-lite |
| --- | --- | --- |
| A, eval on 3.5 | 66 × 200, 7 × 503 | — |
| B, eval on 3.1 | — | 66 × 200 |
| L, live realistic | 12 × 200, 6 × 503, 7 timeouts | 3 × 200, 3 timeouts |
| S, live stress | 7 × 200, 2 × 503, 11 timeouts | 7 × 200 |
| **Total** | **85 × 200, 15 × 503, 18 timeouts** | **76 × 200, 3 timeouts** |

- The judges (Claude Sonnet subagents) made no Gemini calls.
- **Equivalent cost per conversation at list price:**

  | Run | Cost |
  | --- | --- |
  | A (3.5) | $0.00150 |
  | B (3.1) | $0.00112 |

  The real cost is $0 on the free tier.

## Frozen configuration

From this report until the frozen test, **nothing below changes**: no change to prompt, validator, floor, retrieval, models or budget. The freeze is also recorded in ADR-0010, amendment S5c.

| Item | Frozen value |
| --- | --- |
| Code commit | **`2c0c67b`** (`docs: ADR-0009/0010 amendments S5c`). Every S5c run used it. |
| Prompt | **v4** (`packages/core/src/answer/prompts/v4.ts`), source markers `[Sx]`, code blocks validated |
| Model chain (live) | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` |
| Eval primary | `gemini-3.5-flash-lite` |
| Generation | temperature 0, maxOutputTokens 1024, thinking level MINIMAL |
| Live budget | **7,500 ms** for the whole response (retrieval, the chain and post-processing), then `unavailable` |
| Client limits | defaults: 10 RPM / 100,000 TPM / 200 RPD per model (`GEN_LIMITS` not set) |
| Floor | **0.600** (max vector similarity) |
| Retrieval | vector, 20 candidates → 6 sources |
| Validator | quotes of 3–80 words, verbatim; fenced code ≤ 40 lines, verbatim; unmarked claims removed; no valid citation → `insufficient` |
| Embeddings | `gemini-embedding-001`, 768 dimensions; corpus plausible/docs @ `e9a092a…`, 789 chunks |
| Judge | rubric v1 (`evals/judge/rubric-v1.md`), isolated Sonnet subagents in batches of 10 |
| Targets | ADR-0010 with amendment S5c |

## Decisions taken autonomously

- **Live samples ran right away, off-peak.** The owner wrote "corre live" at 04:17 UTC, before the US peak window. The samples ran then and the times are recorded. The availability result may differ at peak: S5b C at peak had fewer stalls but more 503s.
- **Default limits.** The runs used the defaults, per the owner's instruction.
- **Live samples not judged,** as in S5b. Their unjudged batch folders were removed, and the runs carry code metrics only.
- **No fix for the availability miss.** It is reported, and the freeze is respected.

## Risks

- **Availability.** One customer in three would get `unavailable` at the conditions measured.
  - This is the largest open gap, and it does not depend on the prompt.
  - It is a property of free-tier Flash-Lite capacity combined with a chain that lets the primary use the whole budget.
- **Overfitting to dev.** v4 is the third round of rule changes on the same 71 questions. The frozen test is the only unbiased measurement left.
- **Small samples:**
  - abstain n = 14;
  - correct answers 40/45 has a lower bound of 76.5%;
  - the live samples have n = 30.
- **Fallback quality.** 3.1-flash-lite misses citations and abstention on its own. In the stress burst it served 7 of 12 answers, and one of them answered an abstain question.
- **Unverified rate limits.** The defaults are an assumption. No 429 has been seen.
- **Judge vs code.** Code rules and the judge disagree on dev-040 (a wrapped injection).

## Next step: the frozen test (needs explicit owner approval)

1. **The frozen test.** Run v4 on `evals/plausible/test.jsonl`, the only command that reads it, in eval mode on the primary. Then judge it with rubric v1 and aggregate it against the ADR-0010 targets.
   - This needs the **owner's explicit approval**. Until then, test.jsonl stays unread.
2. **Open decision for the owner, before or after the test.** Whether to amend the live chain with a per-attempt cap on the primary, so the fallback always gets time. The new live samples should then run at US peak.
   - This change does not touch the quality configuration the test measures.
   - It does change the frozen budget and chain behavior, so it needs an ADR-0010 amendment and the owner's approval.
