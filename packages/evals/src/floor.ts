import type { ExpectedBehavior } from './schema.ts';

export interface SimilarityRow {
  readonly id: string;
  readonly expected_behavior: ExpectedBehavior;
  readonly max_cosine: number;
}

export interface FloorRule {
  /** Answer questions allowed below the floor. */
  readonly maxAnswerBelow: number;
  /** Behaviors that must never fall below the floor (handled by policy, not by similarity). */
  readonly protectedBehaviors: readonly ExpectedBehavior[];
  readonly decimals: number;
}

/** Approved in S3: at most 1 answer and no handoff/decline below the floor. */
export const DEFAULT_FLOOR_RULE: FloorRule = { maxAnswerBelow: 1, protectedBehaviors: ['handoff', 'decline'], decimals: 3 };

export interface FloorCalibration {
  readonly floor: number;
  /** Which constraint set the value. */
  readonly bindingConstraint: 'answer' | 'protected';
}

/**
 * Highest floor (rounded down to `decimals`) such that at most
 * `maxAnswerBelow` answer questions and no protected question have
 * max similarity strictly below it.
 */
export function calibrateFloor(rows: readonly SimilarityRow[], rule: FloorRule = DEFAULT_FLOOR_RULE): FloorCalibration {
  const answers = rows
    .filter((r) => r.expected_behavior === 'answer')
    .map((r) => r.max_cosine)
    .sort((a, b) => a - b);
  if (answers.length <= rule.maxAnswerBelow) throw new Error('Not enough answer questions to calibrate the floor.');
  const answerBound = answers[rule.maxAnswerBelow] ?? 0;
  const protectedSims = rows.filter((r) => rule.protectedBehaviors.includes(r.expected_behavior)).map((r) => r.max_cosine);
  const protectedBound = protectedSims.length > 0 ? Math.min(...protectedSims) : Number.POSITIVE_INFINITY;
  const bound = Math.min(answerBound, protectedBound);
  const scale = 10 ** rule.decimals;
  return {
    // Epsilon guards against binary rounding (0.6678 * 1e4 = 6677.999…).
    floor: Math.floor(bound * scale + 1e-9) / scale,
    bindingConstraint: protectedBound < answerBound ? 'protected' : 'answer',
  };
}

export interface FloorSensitivityRow {
  readonly floor: number;
  readonly abstainCaught: number;
  readonly abstainTotal: number;
  readonly answerLost: number;
  readonly answerTotal: number;
  readonly handoffBelow: number;
  readonly declineBelow: number;
}

/** For each candidate floor: abstain questions caught and answer questions lost (strictly below). */
export function floorSensitivity(rows: readonly SimilarityRow[], floors: readonly number[]): FloorSensitivityRow[] {
  const count = (behavior: ExpectedBehavior, floor: number): number =>
    rows.filter((r) => r.expected_behavior === behavior && r.max_cosine < floor).length;
  const total = (behavior: ExpectedBehavior): number => rows.filter((r) => r.expected_behavior === behavior).length;
  return [...new Set(floors)]
    .sort((a, b) => a - b)
    .map((floor) => ({
      floor,
      abstainCaught: count('abstain', floor),
      abstainTotal: total('abstain'),
      answerLost: count('answer', floor),
      answerTotal: total('answer'),
      handoffBelow: count('handoff', floor),
      declineBelow: count('decline', floor),
    }));
}

export const SENSITIVITY_FLOORS: readonly number[] = [0.58, 0.6, 0.62, 0.64, 0.6677];

export function floorSensitivityMarkdown(rows: readonly FloorSensitivityRow[], chosen: number): string {
  const lines = [
    '| Floor | abstain caught | answer lost | handoff below | decline below |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.floor.toFixed(4)}${r.floor === chosen ? ' (chosen)' : ''} | ${r.abstainCaught}/${r.abstainTotal} | ` +
        `${r.answerLost}/${r.answerTotal} | ${r.handoffBelow} | ${r.declineBelow} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
