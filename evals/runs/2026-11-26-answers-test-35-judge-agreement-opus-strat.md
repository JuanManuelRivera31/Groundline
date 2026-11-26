# Judge agreement: evals/runs/2026-11-26-answers-test-35.json (opus-strat)

- Design: stratified: all 13 first-judge failures + 20 seeded passing items; seed 20261127.
- First judge: claude-sonnet; second judge: claude-opus; same rubric (v1), isolated, blind to the strata.
- A failure is: correct = false, or unsupported_claims > 0, or appropriate = false.

## Stratum: first-judge failures (13 items; answered by the bot: 6)

- Overall verdict (failure vs pass): 76.9% (10/13) [49.7%–91.8%]; Cohen's kappa 0.00
- correct (answered items): 66.7% (4/6) [30.0%–90.3%]; Cohen's kappa 0.33
- unsupported_claims > 0 (answered items): 83.3% (5/6) [43.6%–97.0%]; Cohen's kappa 0.00
- unsupported_claims, same count: 83.3% (5/6) [43.6%–97.0%]
- appropriate (non-answered items): 100.0% (7/7) [64.6%–100.0%]; Cohen's kappa n/a

| id | field | first judge | second judge |
| --- | --- | --- | --- |
| test-038 | correct | false | true |
| test-082 | unsupported_claims | 1 | 0 |
| test-103 | correct | false | true |

## Stratum: first-judge passing items (20 items; answered by the bot: 14)

- Overall verdict (failure vs pass): 100.0% (20/20) [83.9%–100.0%]; Cohen's kappa n/a
- correct (answered items): 100.0% (14/14) [78.5%–100.0%]; Cohen's kappa n/a
- unsupported_claims > 0 (answered items): 100.0% (14/14) [78.5%–100.0%]; Cohen's kappa n/a
- unsupported_claims, same count: 100.0% (14/14) [78.5%–100.0%]
- appropriate (non-answered items): 100.0% (6/6) [61.0%–100.0%]; Cohen's kappa n/a

Disagreements: none.

## Pooled (stratified sample, not representative of the run) (33 items; answered by the bot: 20)

- Overall verdict (failure vs pass): 90.9% (30/33) [76.4%–96.9%]; Cohen's kappa 0.80
- correct (answered items): 90.0% (18/20) [69.9%–97.2%]; Cohen's kappa 0.69
- unsupported_claims > 0 (answered items): 95.0% (19/20) [76.4%–99.1%]; Cohen's kappa 0.00
- unsupported_claims, same count: 95.0% (19/20) [76.4%–99.1%]
- appropriate (non-answered items): 100.0% (13/13) [77.2%–100.0%]; Cohen's kappa 1.00

| id | field | first judge | second judge |
| --- | --- | --- | --- |
| test-038 | correct | false | true |
| test-082 | unsupported_claims | 1 | 0 |
| test-103 | correct | false | true |

