/**
 * Consistency scoring: rank a player by their floor rather than their ceiling.
 *
 * Every benchmark that exists scores the best run. Voltaic, KovaaK's leaderboards and
 * evxl all take the maximum, which measures what a player can do on their best attempt.
 * Nothing measures what they can do reliably.
 *
 * That gap is not small. Measured on a real corpus, one player's last thirty runs of
 * `PGT` ranged from 1729 to 2909: a **47.9% spread**, all of it invisible to every
 * ranking they appear in. In a game there is no retry, so the 1729 run is the one that
 * decides a fight.
 *
 * Scoring the floor inverts the incentive. Chasing a personal best rewards variance:
 * spam attempts, keep the spike. Scoring the worst of a window punishes it, and the
 * optimal strategy becomes not gambling, which is the thing that actually transfers.
 *
 * The floor is computed from stored history rather than a session the player starts, so
 * there is nothing to abandon when a run goes badly. A bad run is simply part of the
 * record, which is the entire point.
 */

/** Runs considered when computing a floor. */
export const FLOOR_WINDOW = 5;

/** Minimum runs before a floor means anything. */
export const MIN_RUNS_FOR_FLOOR = FLOOR_WINDOW;

export type FloorMethod = "worstOfLast5" | "worstOfLast10" | "p20OfLast20" | "p10OfLast20";

export interface FloorResult {
  /** The floor score, by the chosen method. */
  floor: number;
  /** Best score in the same history: what every other benchmark ranks. */
  ceiling: number;
  /** Median, for context. */
  median: number;
  /** (ceiling − floor) / ceiling. Lower is more consistent. */
  gap: number;
  runsConsidered: number;
  /** True when there was too little history for the floor to be meaningful. */
  provisional: boolean;
}

function quantile(sortedAscending: number[], q: number): number {
  if (sortedAscending.length === 0) return 0;
  const i = (sortedAscending.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi
    ? sortedAscending[lo]
    : sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (i - lo);
}

/**
 * Compute a floor from a score history.
 *
 * @param scores oldest first.
 */
export function computeFloor(
  scores: number[],
  method: FloorMethod = "worstOfLast5",
): FloorResult | null {
  if (scores.length === 0) return null;

  const sortedAll = [...scores].sort((a, b) => a - b);
  const ceiling = sortedAll[sortedAll.length - 1];
  const median = quantile(sortedAll, 0.5);

  let window: number[];
  let floor: number;

  switch (method) {
    case "worstOfLast5":
      window = scores.slice(-5);
      floor = Math.min(...window);
      break;
    case "worstOfLast10":
      window = scores.slice(-10);
      floor = Math.min(...window);
      break;
    case "p20OfLast20":
      window = scores.slice(-20);
      floor = quantile([...window].sort((a, b) => a - b), 0.2);
      break;
    case "p10OfLast20":
      window = scores.slice(-20);
      floor = quantile([...window].sort((a, b) => a - b), 0.1);
      break;
  }

  // A ceiling at or below zero cannot express a gap as a fraction. Pressure scenarios
  // can score negative, so this is a real case rather than a defensive stub.
  const gap = ceiling > 0 ? (ceiling - floor) / ceiling : 0;

  return {
    floor,
    ceiling,
    median,
    gap,
    runsConsidered: window.length,
    provisional: scores.length < MIN_RUNS_FOR_FLOOR,
  };
}

export interface ScenarioFloor extends FloorResult {
  scenario: string;
}

/** Compute floors for many scenarios at once. */
export function floorsFor(
  history: Map<string, number[]>,
  method: FloorMethod = "worstOfLast5",
): Map<string, ScenarioFloor> {
  const out = new Map<string, ScenarioFloor>();
  for (const [scenario, scores] of history) {
    const result = computeFloor(scores, method);
    if (result) out.set(scenario, { scenario, ...result });
  }
  return out;
}

/**
 * How far a player's floor sits below their ceiling, across many scenarios.
 *
 * Reported as a single headline number because closing it is the whole point of the
 * mode, and a number people can watch fall is what makes a stat worth chasing.
 */
export function overallGap(floors: Iterable<ScenarioFloor>): number {
  const usable = [...floors].filter((f) => !f.provisional && f.ceiling > 0);
  if (usable.length === 0) return 0;
  return usable.reduce((sum, f) => sum + f.gap, 0) / usable.length;
}
