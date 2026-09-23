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
 *   - On a *windowed* ladder a scenario is one variant of a family, and the family is
 *     what gets graded: variant energy is offset by the ranks below its window, and the
 *     family's energy is the **best** of its variants, not their sum. Below its own
 *     first threshold a variant above window 0 is silent rather than interpolating from
 *     zero, because a linear ramp from zero across a window it does not cover would
 *     credit a bad score on a hard scenario as though it were a good one on an easy one.
 *   - Category energy is the plain sum of its families' energy.
 *   - Category rank is the highest threshold in the category's own `rankMaxes`
 *     that the category energy meets.
 *   - Overall progress is the sum of category energy. For a KovaaK's benchmark the
 *     overall rank is the highest index where that meets the lowest category's
 *     threshold times the number of categories, which is what their servers report. For a season, where each category
 *     has its own ladder, summing is meaningless and the overall is derived from how
 *     far along its own ladder each category is.
 *
 * Note the category thresholds differ per category (Switching demands more energy
 * for the same rank than Clicking does) but the per-scenario energy scale is
 * universal. That asymmetry is deliberate in the benchmark design, and getting it
 * backwards is the easy mistake here.
 */

import type { CategoryDef, DifficultyDef, ScenarioDef } from "./types.ts";
import { windowForRank } from "../season/windows.ts";

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
  /**
   * The variant this result speaks for: on a windowed ladder, whichever of the family's
   * variants earned the family its energy, so `score` and `scenario` always agree.
   */
  scenario: ScenarioDef;
  score: number;
  energy: number;
  rankIndex: number;
  rankName: string | null;
  /** Score needed for the next rank, and the gap to it. Null at max rank. */
  nextRankName: string | null;
  nextRankScore: number | null;
  gapToNextRank: number | null;
  /**
   * Which scenario the next rank is scored on.
   *
   * Not always the one above: the next rank can live in the next window, and then it is
   * a harder variant that grades it. Saying "930 on Pasu" when the 930 is on a scenario
   * the player has never launched is the single most confusing thing a windowed ladder
   * can do, so the target names itself.
   */
  nextRankScenario: string | null;
  /**
   * The player's current score on `nextRankScenario`.
   *
   * Not the same as `score` once the next rank lives in a harder window: `score` belongs
   * to whichever variant earned the rank, and the target belongs to the one that grades
   * the next. Anything phrasing the gap as "you are at X, you need Y" has to use this
   * one, or it prints two numbers from two different scenarios and reads as nonsense.
   */
  nextRankFromScore: number | null;
  /** The family graded, for a windowed ladder. Equal to the scenario name otherwise. */
  family: string;
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
  /**
   * The positional top rank, when this category has one.
   *
   * `eligible` says the player holds the highest rank energy can prove, which is the
   * precondition and not the rank. Whether they actually hold it depends on where they
   * sit on the apex board, which this module cannot see and must not guess - so it says
   * "eligible" and stops. Null when the category has no positional rank.
   */
  positional: { rankName: string; topN: number; eligible: boolean } | null;
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

/**
 * Energy one variant is worth, and the global rank it proves.
 *
 * `offset` is how many ranks sit below this variant's window. A variant above window 0
 * proves nothing below its own first threshold: the window under it is what measures
 * that range, and a family takes the best of its variants, so staying silent costs a
 * player nothing they have actually earned.
 */
function variantEnergy(
  score: number,
  rankMaxes: number[],
  offset: number,
): { energy: number; rankIndex: number } {
  const idx = rankIndex(score, rankMaxes);

  if (offset > 0 && idx < 0) return { energy: 0, rankIndex: -1 };

  return {
    energy: offset * ENERGY_PER_RANK + scenarioEnergy(score, rankMaxes),
    rankIndex: idx < 0 ? -1 : offset + idx,
  };
}

/**
 * Grade one family against the whole ladder.
 *
 * `variants` is one scenario on a flat ladder and one per window on a windowed one, in
 * window order. `windowSize` is how many ranks each window covers, and equals the whole
 * ladder for a flat one.
 */
function evaluateFamily(
  family: string,
  variants: ScenarioDef[],
  scores: Map<string, number>,
  rankNames: string[],
  windowSize: number,
  overlap: number,
): ScenarioResult {
  let best = { energy: 0, rankIndex: -1, scenario: variants[0], score: scores.get(variants[0].name) ?? 0 };

  for (const variant of variants) {
    const score = scores.get(variant.name) ?? 0;
    const offset = (variant.window ?? 0) * windowSize;
    const graded = variantEnergy(score, variant.rankMaxes, offset);

    // Strictly greater, so a tie keeps the easier variant. That matters at zero: a
    // player who has scored nothing ties every window, and the useful thing to show them
    // is the one at the bottom - the scenario they should actually launch - rather than
    // an Advanced scenario they have never opened.
    if (graded.energy > best.energy) {
      best = { energy: graded.energy, rankIndex: graded.rankIndex, scenario: variant, score };
    }
  }

  // The ladder's depth, not the variants' - a family short of a window would otherwise
  // quietly shorten its own ladder instead of being reported as the mistake it is.
  const totalRanks = rankNames.length;
  const nextIdx = best.rankIndex + 1;
  const hasNext = nextIdx < totalRanks;

  // The next rank belongs to whichever window contains it, which is not always the
  // window the player is being graded in. Where windows overlap, two of them contain it,
  // and the lower one is the answer: it is the easier scenario, and the one the player is
  // more likely to have launched. Naming the harder one is how a target reads as
  // impossible when it is one good run away on a scenario they already play.
  const nextWindow = windowForRank(nextIdx, windowSize, overlap);
  const target = hasNext
    ? (variants.find((v) => (v.window ?? 0) === nextWindow) ?? null)
    : null;
  const nextRankScore = target
    ? (target.rankMaxes[nextIdx - nextWindow * windowSize] ?? null)
    : null;
  const nextRankFromScore = target ? (scores.get(target.name) ?? 0) : null;

  return {
    scenario: best.scenario,
    score: best.score,
    energy: best.energy,
    rankIndex: best.rankIndex,
    rankName: best.rankIndex >= 0 ? (rankNames[best.rankIndex] ?? null) : null,
    nextRankName: hasNext ? (rankNames[nextIdx] ?? null) : null,
    nextRankScore,
    gapToNextRank:
      nextRankScore !== null && nextRankFromScore !== null
        ? Math.max(0, nextRankScore - nextRankFromScore)
        : null,
    nextRankScenario: target ? target.name : null,
    nextRankFromScore,
    family,
  };
}

function evaluateCategory(
  category: CategoryDef,
  scores: Map<string, number>,
  rankNames: string[],
): CategoryResult {
  // A flat ladder is the degenerate case of a windowed one: every scenario is its own
  // family in window 0, and the window is the whole ladder. Written that way so there is
  // one path through this code rather than two, and so the KovaaK's numbers this module
  // is validated against keep coming out of the same arithmetic they always did.
  const windowSize = category.windowSize ?? category.rankMaxes.length;
  const overlap = category.windowOverlap ?? 0;

  const families = new Map<string, ScenarioDef[]>();
  for (const s of category.scenarios) {
    const key = s.family ?? s.name;
    const list = families.get(key) ?? [];
    list.push(s);
    families.set(key, list);
  }

  const scenarios = [...families].map(([family, variants]) =>
    evaluateFamily(
      family,
      [...variants].sort((a, b) => (a.window ?? 0) - (b.window ?? 0)),
      scores,
      rankNames,
      windowSize,
      overlap,
    ),
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

  // The positional rank is the name past the last threshold. `idx` comes from
  // `rankIndex`, which reads `rankMaxes` alone, so it can never point at this one - the
  // rank is unreachable by arithmetic on purpose, and eligibility is all that is reported.
  const positional = category.positional
    ? {
        rankName: rankNames[category.rankMaxes.length] ?? "",
        topN: category.positional.topN,
        eligible: idx === category.rankMaxes.length - 1,
      }
    : null;

  return {
    name: category.name,
    energy,
    rankIndex: idx,
    rankName: idx >= 0 ? (rankNames[idx] ?? null) : null,
    scenarios,
    rankCount: category.rankMaxes.length,
    progressToNextRank,
    positional,
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
  // the summed energy against the lowest category's threshold at each rank, times the
  // number of categories. That is not a choice, it is what their servers report, and
  // validateEngine holds this code to matching it.
  //
  // It used to be the summed thresholds, and the two only differ where one category asks
  // more per rank than the others - Voltaic S5 Intermediate, where Switching asks 17,500
  // to Clicking's and Tracking's 15,000. There KovaaK's placed a player with 139,179.96
  // energy at Jade: the summed Jade bar is 142,500, the lowest-times-three one is 135,000.
  // That is the one observation that tells the rules apart; every other comparison the
  // validator makes agrees under both.
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
      const at = difficulty.categories.map((c) => c.rankMaxes[i]).filter((t): t is number => t !== undefined);
      overallThresholds.push(at.length ? Math.min(...at) * difficulty.categories.length : 0);
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
