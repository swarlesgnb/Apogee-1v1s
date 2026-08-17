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
 *   - Overall progress is the sum of category energy; overall rank is the highest
 *     index where progress meets the summed category thresholds.
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

  return {
    name: category.name,
    energy,
    rankIndex: idx,
    rankName: idx >= 0 ? (rankNames[idx] ?? null) : null,
    scenarios,
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

  const categories = difficulty.categories.map((c) =>
    evaluateCategory(c, scores, rankNames),
  );

  const totalEnergy = categories.reduce((sum, c) => sum + c.energy, 0);

  // Overall thresholds are the per-rank sums of every category's thresholds.
  const rankCount = Math.max(
    0,
    ...difficulty.categories.map((c) => c.rankMaxes.length),
  );
  const overallThresholds: number[] = [];
  for (let i = 0; i < rankCount; i++) {
    overallThresholds.push(
      difficulty.categories.reduce((sum, c) => sum + (c.rankMaxes[i] ?? 0), 0),
    );
  }

  const idx = rankIndex(totalEnergy, overallThresholds);

  let progressToNextRank: number | null = null;
  const nextIdx = idx + 1;
  if (nextIdx < overallThresholds.length) {
    const lo = idx >= 0 ? overallThresholds[idx] : 0;
    const hi = overallThresholds[nextIdx];
    progressToNextRank = hi > lo ? (totalEnergy - lo) / (hi - lo) : 1;
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
