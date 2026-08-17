/**
 * Baseline computation, with no filesystem dependency.
 *
 * Split out from history.ts so it can run in a Deno Edge Function. history.ts scans a
 * folder and therefore imports node:fs; the maths below is pure and is the half the
 * server needs, since baselines are computed server-side and never trusted from a
 * client (PLAN.md §7).
 *
 * The baseline is the centre every match is measured from, so it needs two properties
 * at once:
 *
 *   UNGAMEABLE  deliberately playing badly must not drag it down, or sandbagging
 *               becomes the dominant strategy.
 *   CENTRED     a typical run should sit near 0%, so a good day reads as +x% and a bad
 *               day as −x%.
 *
 * An earlier version used the mean of the top 30% of recent runs for the first
 * property. Measured across 156 scenarios of real history it was badly off-centre:
 * only **26%** of genuine runs landed above their own baseline, so matches were decided
 * by who avoided a disaster rather than who played well.
 *
 *     definition   mean delta   above baseline   sandbag drop
 *     top 30%          −3.8%             26%            3.0%
 *     median           +0.4%             58%            3.5%
 *     plain mean       +0.6%             60%            9.3%
 *
 * The **verified-PB floor** is what defeats sandbagging, not the high-water statistic.
 * With the floor in place a median is centred and nearly as hard to game, while a plain
 * mean is three times more gameable.
 */

/** Recent runs considered when computing a baseline. */
export const BASELINE_WINDOW = 50;

/** Baseline may never fall below this fraction of the verified personal best. */
export const PB_FLOOR_FRACTION = 0.9;

/** Below this many runs a baseline is provisional and needs a fallback. */
export const MIN_RUNS_FOR_BASELINE = 5;

export interface Baseline {
  scenario: string;
  value: number;
  runCount: number;
  /** True when there was too little history to trust the number. */
  provisional: boolean;
  /** Whether the verified-PB floor was the binding constraint. */
  flooredByPb: boolean;
}

/**
 * Median of the most recent `BASELINE_WINDOW` scores.
 *
 * A median rather than a mean because it ignores outliers in both directions: one
 * disastrous run does not drop it, and one lucky run does not raise it.
 *
 * @param scores oldest first.
 */
export function recentMedian(scores: number[]): number {
  if (scores.length === 0) return 0;

  const recent = [...scores.slice(-BASELINE_WINDOW)].sort((a, b) => a - b);
  const mid = Math.floor(recent.length / 2);

  return recent.length % 2 === 0 ? (recent[mid - 1] + recent[mid]) / 2 : recent[mid];
}

/**
 * Compute a scenario's baseline from a score history.
 *
 * @param scores    oldest first.
 * @param verifiedPb KovaaK's server-side personal best, if known. Supplies the floor.
 */
export function baselineFromScores(
  scenario: string,
  scores: number[],
  verifiedPb?: number | null,
): Baseline {
  const raw = recentMedian(scores);
  const floor = verifiedPb != null && verifiedPb > 0 ? verifiedPb * PB_FLOOR_FRACTION : 0;

  return {
    scenario,
    value: Math.max(raw, floor),
    runCount: scores.length,
    provisional: scores.length < MIN_RUNS_FOR_BASELINE,
    flooredByPb: floor > raw && floor > 0,
  };
}

/**
 * Performance of a run relative to a baseline, as a signed fraction.
 * This is the quantity matches are decided on.
 */
export function delta(score: number, baseline: number): number | null {
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  if (!Number.isFinite(score)) return null;
  return (score - baseline) / baseline;
}
