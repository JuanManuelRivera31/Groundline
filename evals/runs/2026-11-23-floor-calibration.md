# FLOOR calibration (dev)

- Source run: `evals/runs/2026-11-23-vector.json`
- Rule: highest floor with at most 1 answer question and no handoff/decline question below it.
- FLOOR: **0.600** (binding constraint: protected).

## Sensitivity

| Floor | abstain caught | answer lost | handoff below | decline below |
| --- | --- | --- | --- | --- |
| 0.5800 | 5/14 | 0/45 | 0 | 0 |
| 0.6000 (chosen) | 5/14 | 0/45 | 0 | 0 |
| 0.6200 | 5/14 | 0/45 | 0 | 2 |
| 0.6400 | 5/14 | 0/45 | 0 | 2 |
| 0.6677 | 6/14 | 1/45 | 0 | 4 |
