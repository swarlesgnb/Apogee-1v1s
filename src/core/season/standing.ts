/**
 * The apex board: what a player chases once the ladder has nothing left to say.
 *
 * WHAT THIS IS FOR
 *
 * A rank is a band, and a band has a top. `scenarioEnergy` caps at the last threshold on
 * purpose, so two players who have both cleared the hardest rank hold identical energy
 * however far apart they are - and the group that most wants a reason to keep playing is
 * exactly the group the ladder has stopped measuring.
 *
 * So this is a second standing, not a longer ladder. The ladder still answers "what rank
 * am I", frozen for the season, settled by thresholds nobody can move. The apex board
 * answers "how deep into the top am I", it never caps, and it re-reads the same KovaaK's
 * boards the thresholds were cut from. Neither feeds the other: ratings, matchmaking and
 * settlement do not read a word of this file, for the same reason they do not read a
 * threshold (PLAN.md §14).
 *
 * ONE SCENARIO PER FAMILY, AND IT IS THE HARDEST ONE
 *
 * The ladder grades a family on the *best* of its variants, which is right for a rank:
 * a player should be credited for the hardest thing they can do, and a maxed easy
 * scenario honestly proves the ranks below it.
 *
 * Carrying that rule up here would break it. A percentile is a percentile *of the people
 * who played that scenario*, and an easy board is enormous and mostly people who opened it
 * once while a hard board is small and entirely people who sought it out. So the same
 * player reads *better* on the easier scenario, and "best fraction across the variants"
 * would hand a family its highest score for playing down - the sandbagging shape §3 spends
 * a whole section closing off.
 *
 * That is measured, not assumed. Across the corpus, on **26 of the 43 variant pairs** where
 * one player has a score on both an easier variant and the graded one, the easier scenario
 * pays more: 1w2ts reload smallflicks larger pays 1.12 where the Expert variant of the same
 * family pays 0.48. `validateStanding` re-derives that number.
 *
 * The fix is to remove the choice. Every family is graded on its top-window variant and
 * only that one, so every player on the apex board is compared on the same board as every
 * other, and there is no easier road onto it. That costs nothing in reach: the top window
 * is what a player who has finished the ladder is already playing.
 *
 * A family the player has no score on contributes zero. That is honest rather than harsh -
 * the apex board is a separate standing, so a missing Expert score costs a player nothing
 * whatsoever on their actual rank.
 *
 * WHY POINTS AND NOT A PERCENTILE
 *
 * Summing raw fractions would be dominated by the family a player is worst at, and
 * averaging them would make the difference between top 2% and top 1% look like the
 * difference between 51% and 50%. `apexPoints` takes -log10, so a whole point always
 * means "ten times fewer people above you" wherever on the scale it falls, and the sum
 * across families behaves the way category energy already does.
 */

import { apexPoints, apexTopFraction, type ApexBoard } from "./apex.ts";
import type { Distribution } from "./percentiles.ts";
import type { Season } from "./season.ts";

export interface FamilyStanding {
  family: string;
  subCategory: string | null;
  /** The top-window variant, the only one this board grades. */
  scenario: string;
  label: string;
  score: number | null;
  /** Fraction from the top of that scenario's board, or null with no score. */
  topFraction: number | null;
  /** Position on the board, in players. Null when the board could not place the score. */
  boardRank: number | null;
  /** Board size, for reading `boardRank` against. */
  boardTotal: number | null;
  points: number;
}

export interface CategoryStanding {
  name: string;
  points: number;
  families: FamilyStanding[];
  /** Families with a score, out of all of them. A partial standing is not a bad one. */
  graded: number;
  total: number;
}

export interface ApexStanding {
  categories: CategoryStanding[];
  points: number;
  graded: number;
  total: number;
}

export interface ApexSources {
  boards: Map<string, ApexBoard>;
  distributions: Map<string, Distribution>;
}

/**
 * The top-window variant of every family, keyed by family.
 *
 * Derived from the season rather than assumed to be window 3: a season with three windows
 * has its top at 2, and hard-coding the number is how a pool change silently starts
 * grading everybody on a scenario one band too easy.
 */
export function topWindowVariants(season: Season): Map<string, (typeof season.scenarios)[number]> {
  const best = new Map<string, (typeof season.scenarios)[number]>();

  for (const s of season.scenarios) {
    const family = s.family ?? s.scenario;
    const prior = best.get(family);
    if (!prior || (s.window ?? 0) > (prior.window ?? 0)) best.set(family, s);
  }

  return best;
}

/**
 * A player's apex standing for a season.
 *
 * `scores` is keyed on the exact KovaaK's scenario name, the same map `evaluateBenchmark`
 * takes, so a caller that already has one does not need a second.
 */
export function apexStanding(
  season: Season,
  scores: Map<string, number>,
  sources: ApexSources,
): ApexStanding {
  const variants = topWindowVariants(season);

  const byCategory = new Map<string, FamilyStanding[]>();
  for (const category of season.categories) byCategory.set(category.name, []);

  for (const [family, variant] of variants) {
    const raw = scores.get(variant.scenario);
    const score = Number.isFinite(raw) && (raw as number) > 0 ? (raw as number) : null;

    const board = sources.boards.get(variant.scenario) ?? null;
    const dist = sources.distributions.get(variant.scenario) ?? null;

    const topFraction = score === null ? null : apexTopFraction(board, dist, score);

    // Reported in players as well as as a fraction, because "rank 34 of 22,983" is the
    // sentence a player actually wants and a fraction is not it.
    const boardTotal = board?.total ?? dist?.total ?? null;
    const boardRank =
      topFraction !== null && boardTotal !== null ? topFraction * boardTotal : null;

    const standing: FamilyStanding = {
      family,
      subCategory: variant.subCategory ?? null,
      scenario: variant.scenario,
      label: variant.label ?? variant.scenario,
      score,
      topFraction,
      boardRank,
      boardTotal,
      points: apexPoints(topFraction),
    };

    const bucket = byCategory.get(variant.category);
    // A scenario in a category the season does not declare is a broken season, not a
    // reason to drop a family silently. validateSeason is what refuses it.
    if (bucket) bucket.push(standing);
  }

  const categories: CategoryStanding[] = season.categories.map((c) => {
    const families = (byCategory.get(c.name) ?? []).sort((a, b) =>
      a.family.localeCompare(b.family),
    );
    return {
      name: c.name,
      points: families.reduce((sum, f) => sum + f.points, 0),
      families,
      graded: families.filter((f) => f.score !== null).length,
      total: families.length,
    };
  });

  return {
    categories,
    points: categories.reduce((sum, c) => sum + c.points, 0),
    graded: categories.reduce((sum, c) => sum + c.graded, 0),
    total: categories.reduce((sum, c) => sum + c.total, 0),
  };
}

/**
 * Load the two reference files the standing reads.
 *
 * Kept out of `apexStanding` so the computation stays pure and testable without a disk,
 * which is what lets `validateStanding` sweep the real corpus through it.
 */
export interface ApexFile {
  boards: ApexBoard[];
}
export interface PercentileFile {
  distributions: Distribution[];
}

export function apexSources(apex: ApexFile, percentiles: PercentileFile): ApexSources {
  return {
    boards: new Map(apex.boards.map((b) => [b.scenario, b])),
    distributions: new Map(percentiles.distributions.map((d) => [d.scenario, d])),
  };
}
