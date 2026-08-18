/**
 * Voltaic-style energy and rank computation.
 *
 * The model below was reverse-engineered from KovaaK's own benchmark API and then
 * validated against real accounts: computed category and overall progress match the
 * server's reported values to within 0.005 energy across every category. See
 * `validateEngine.ts`, which re-runs that check against live accounts.
 *
 * The rules:
 *
 *   - Each scenario has ascending score thresholds (`rankMaxes`), one per rank.
 *     Hitting threshold i is worth `ENERGY_PER_RANK * (i + 1)` energy.
 *     Between thresholds, energy interpolates linearly. Below the first, it
 *     interpolates linearly from zero. Above the last, it caps.
 *   - Category energy is the plain sum of its scenarios' energy.
 *   - Category rank is the highest threshold in the category's own `rankMaxes`
 *     that the category energy meets.
 *   - Overall progress is the sum of category energy. For a KovaaK's benchmark the
 *     overall rank is the highest index where that meets the summed category
 *     thresholds, which is what their servers report. For a season, where each category
 *     has its own ladder, summing is meaningless and the overall is derived from how
 *     far along its own ladder each category is.
 *
 * Note the category thresholds differ per category (Switching demands more energy
 * for the same rank than Clicking does) but the per-scenario energy scale is
 * universal. That asymmetry is deliberate in the benchmark design, and getting it
 * backwards is the easy mistake here.
 */

import type { CategoryDef, DifficultyDef, ScenarioDef } from "./types.ts";

/** Energy granted per rank step at a scenario's threshold. */
export const ENERGY_PER_RANK = 2500;

/**
 * Energy earned on one scenario for a given raw score.
 * Returns 0 for a score of zero or below, and caps at the top rank.
 */
export function scenarioEnergy(score: number, rankMaxes: number[]): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  if (rankMaxes.length === 0) return 0;

  if (score < rankMaxes[0]) {
    return (ENERGY_PER_RANK * score) / rankMaxes[0];
  }

  for (let i = 0; i < rankMaxes.length - 1; i++) {
    if (score < rankMaxes[i + 1]) {
      const lo = rankMaxes[i];
      const hi = rankMaxes[i + 1];
      // Guard against a malformed definition with duplicate thresholds.
      if (hi <= lo) return ENERGY_PER_RANK * (i + 1);
      return (
        ENERGY_PER_RANK * (i + 1) +
        (ENERGY_PER_RANK * (score - lo)) / (hi - lo)
      );
    }
  }

  return ENERGY_PER_RANK * rankMaxes.length;
}

/**
 * Index of the highest threshold met, or -1 for none.
 * Callers map this into `rankNames` (where 0 is the first named rank).
 */
export function rankIndex(value: number, thresholds: number[]): number {
  let idx = -1;
  for (let i = 0; i < thresholds.length; i++) {
    if (value >= thresholds[i]) idx = i;
    else break;
  }
  return idx;
}

export interface ScenarioResult {
  scenario: ScenarioDef;
  score: number;
  energy: number;
  rankIndex: number;
  rankName: string | null;
  /** Score needed for the next rank, and the gap to it. Null at max rank. */
  nextRankName: string | null;
  nextRankScore: number | null;
  gapToNextRank: number | null;
}

export interface CategoryResult {
  name: string;
  energy: number;
  rankIndex: number;
  rankName: string | null;
  scenarios: ScenarioResult[];
  /** How many ranks this category's ladder has. */
  rankCount: number;
  /** Fraction of the way from this rank to the next, or null at the top. */
  progressToNextRank: number | null;
}

export interface BenchmarkResult {
  difficulty: string;
  totalEnergy: number;
  rankIndex: number;
  rankName: string | null;
  categories: CategoryResult[];
  /** Progress toward the next overall rank, 0..1. */
  progressToNextRank: number | null;
}

function evaluateScenario(
  scenario: ScenarioDef,
  score: number,
  rankNames: string[],
): ScenarioResult {
  const idx = rankIndex(score, scenario.rankMaxes);
  const nextIdx = idx + 1;
  const hasNext = nextIdx < scenario.rankMaxes.length;

  return {
    scenario,
    score,
    energy: scenarioEnergy(score, scenario.rankMaxes),
    rankIndex: idx,
    rankName: idx >= 0 ? (rankNames[idx] ?? null) : null,
    nextRankName: hasNext ? (rankNames[nextIdx] ?? null) : null,
    nextRankScore: hasNext ? scenario.rankMaxes[nextIdx] : null,
    gapToNextRank: hasNext
      ? Math.max(0, scenario.rankMaxes[nextIdx] - score)
      : null,
  };
}

function evaluateCategory(
  category: CategoryDef,
  scores: Map<string, number>,
  rankNames: string[],
): CategoryResult {
  const scenarios = category.scenarios.map((s) =>
    evaluateScenario(s, scores.get(s.name) ?? 0, rankNames),
  );

  const energy = scenarios.reduce((sum, s) => sum + s.energy, 0);
  const idx = rankIndex(energy, category.rankMaxes);

  // Where this category sits between its current rank and the next. Reported because
  // the overall rank is derived from it: without a fraction, three categories could
  // only ever land the overall on whole steps.
  let progressToNextRank: number | null = null;
  const next = idx + 1;
  if (next < category.rankMaxes.length) {
    const lo = idx >= 0 ? category.rankMaxes[idx] : 0;
    const hi = category.rankMaxes[next];
    progressToNextRank = hi > lo ? Math.min(1, Math.max(0, (energy - lo) / (hi - lo))) : 1;
  }

  return {
    name: category.name,
    energy,
    rankIndex: idx,
    rankName: idx >= 0 ? (rankNames[idx] ?? null) : null,
    scenarios,
    rankCount: category.rankMaxes.length,
    progressToNextRank,
  };
}

/**
 * Evaluate a whole difficulty for a player.
 *
 * @param scores Raw best score per scenario name. Missing scenarios count as 0.
 */
export function evaluateBenchmark(
  difficulty: DifficultyDef,
  scores: Map<string, number>,
): BenchmarkResult {
  const { rankNames } = difficulty;

  // A category may carry its own ladder. Where it does, its ranks and its scenarios'
  // are named from that rather than from the benchmark's, which is what lets three
  // categories be three ladders instead of three views of one.
  const categories = difficulty.categories.map((c) =>
    evaluateCategory(c, scores, c.rankNames ?? rankNames),
  );

  const totalEnergy = categories.reduce((sum, c) => sum + c.energy, 0);

  // How the overall rank is reached depends on what is being evaluated.
  //
  // A KovaaK's benchmark has one ladder for all its categories, and its overall rank is
  // the summed energy against the summed thresholds. That is not a choice, it is what
  // their servers report, and validateEngine holds this code to matching it - so that
  // path is preserved exactly.
  //
  // A season gives each category its own ladder (PLAN.md §14), and summing stops
  // meaning anything: a four-rank category contributes nothing to a fifth threshold, so
  // the overall bar falls every time one ladder is shorter than another, and the index
  // that comes out is then read against a list of names that may be a third length
  // again. There the overall is *derived* instead.
  const perCategoryLadders = difficulty.categories.some((c) => c.rankNames);

  let idx: number;
  let progressToNextRank: number | null = null;

  if (!perCategoryLadders) {
    const rankCount = Math.max(0, ...difficulty.categories.map((c) => c.rankMaxes.length));
    const overallThresholds: number[] = [];
    for (let i = 0; i < rankCount; i++) {
      overallThresholds.push(
        difficulty.categories.reduce((sum, c) => sum + (c.rankMaxes[i] ?? 0), 0),
      );
    }

    idx = rankIndex(totalEnergy, overallThresholds);

    const nextIdx = idx + 1;
    if (nextIdx < overallThresholds.length) {
      const lo = idx >= 0 ? overallThresholds[idx] : 0;
      const hi = overallThresholds[nextIdx];
      progressToNextRank = hi > lo ? (totalEnergy - lo) / (hi - lo) : 1;
    }
  } else {
    // Each category is reduced to its *standing* - how far along its own ladder the
    // player is, as a fraction - and the overall is where the average of those falls on
    // the overall ladder. Ladders of different depths compare correctly because nothing
    // is compared until it is already a fraction.
    //
    // The average, not the weakest. Being carried by one strong category is a real
    // thing this will say about somebody, and a mean says it; a minimum would make the
    // overall a second, harsher name for the weakest category, which the weakness map
    // already reports and reports better.
    const standings = categories.map((c) => {
      const depth = c.rankCount > 0 ? c.rankCount : 1;
      // rankIndex is -1 below the first threshold, so +1 puts an unranked category at 0
      // and the top rank at depth.
      return Math.min(1, (c.rankIndex + 1 + (c.progressToNextRank ?? 0)) / depth);
    });

    const standing =
      standings.length > 0 ? standings.reduce((a, b) => a + b, 0) / standings.length : 0;

    const depth = rankNames.length;
    const scaled = standing * depth;
    idx = Math.min(depth - 1, Math.ceil(scaled) - 1);
    progressToNextRank = idx + 1 < depth ? Math.min(1, Math.max(0, scaled - Math.floor(scaled))) : null;
  }

  return {
    difficulty: difficulty.name,
    totalEnergy,
    rankIndex: idx,
    rankName: idx >= 0 ? (rankNames[idx] ?? null) : null,
    categories,
    progressToNextRank,
  };
}
