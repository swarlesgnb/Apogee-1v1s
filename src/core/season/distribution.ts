/**
 * What a ladder does to the population.
 *
 * Tuning thresholds without this is guesswork: you can see that rank 7 asks for 929, and
 * not that rank 7 holds two players in a thousand. The scores at every percentile of every
 * scenario are already cached, so the answer is computable without an Apogee population -
 * which is the same trick the thresholds themselves use.
 *
 * THE METHOD
 *
 * Sweep a hypothetical player from the bottom of the board to the top. At percentile p,
 * give them the score at p on every scenario, grade them with the real engine, and record
 * which rank they land in. Because a percentile *is* a share of the population, the width
 * of the p-range that lands in a rank is the share of players in that rank.
 *
 * THE ASSUMPTION, STATED
 *
 * That player is equally good at everything: p on Pasu, p on Aether, p on DriftTS. Real
 * players are not - they are stronger at some things than others - and that spread makes
 * the real distribution flatter than this one, pulling players out of the middle ranks and
 * into the tails. So read this as the sharpest shape the ladder can produce. If a rank is
 * empty here it is empty in reality; if a rank is crowded here it is somewhat less so.
 *
 * Nothing here re-implements the energy rules. It builds a score map and hands it to
 * `evaluateBenchmark`, so a ladder previewed here is graded by the code that grades a
 * player, and the two cannot drift.
 */

import { evaluateBenchmark } from "../benchmarks/energy.ts";
import { seasonAsDifficulty, type Season } from "./season.ts";
import { scoreAtTopFraction, type Distribution } from "./percentiles.ts";

/** How finely to sweep the population. 400 steps is a quarter of a percent. */
const STEPS = 400;

export interface RankShare {
  rank: number;
  name: string;
  /** Share of players landing in this rank, 0..1. */
  share: number;
  /** Energy a player at the middle of this band carries, for a sense of scale. */
  energy: number;
}

export interface CategoryDistribution {
  category: string;
  /** One entry per rank, plus index -1 for unranked, which is the first entry. */
  ranks: RankShare[];
  /** Share of players who do not reach the first rank. */
  unranked: number;
  /** Ranks no player reaches at all. The ones worth knowing about. */
  empty: string[];
}

/**
 * Population share per rank, for every category in the season.
 *
 * `distributions` is the sampled leaderboard cache, keyed on scenario name.
 */
export function rankDistribution(
  season: Season,
  distributions: Map<string, Distribution>,
): CategoryDistribution[] {
  const difficulty = seasonAsDifficulty(season);

  // Sweep from the bottom of the board upward, so the counts accumulate in rank order.
  const byCategory = new Map<string, { counts: Map<number, number>; energy: Map<number, number> }>();
  for (const c of difficulty.categories) {
    byCategory.set(c.name, { counts: new Map(), energy: new Map() });
  }

  let sampled = 0;

  for (let step = 0; step < STEPS; step++) {
    // Midpoint of the step, so neither end is over-weighted. topFraction runs from the top
    // of the board (0) downward, so a high fraction is a weak player.
    const topFraction = 1 - (step + 0.5) / STEPS;

    const scores = new Map<string, number>();
    let any = false;

    for (const s of season.scenarios) {
      const dist = distributions.get(s.scenario);
      if (!dist) continue;
      const score = scoreAtTopFraction(dist, topFraction);
      if (score === null) continue;
      scores.set(s.scenario, score);
      any = true;
    }

    if (!any) continue;
    sampled++;

    const result = evaluateBenchmark(difficulty, scores);

    for (const cat of result.categories) {
      const bucket = byCategory.get(cat.name);
      if (!bucket) continue;
      bucket.counts.set(cat.rankIndex, (bucket.counts.get(cat.rankIndex) ?? 0) + 1);
      // Kept as a running last-seen rather than an average: within a rank the energy at
      // the top of the band is the interesting number, and the sweep ends there.
      bucket.energy.set(cat.rankIndex, cat.energy);
    }
  }

  if (sampled === 0) return [];

  return difficulty.categories.map((cat) => {
    const bucket = byCategory.get(cat.name)!;
    const names = cat.rankNames ?? difficulty.rankNames;

    const ranks: RankShare[] = names.map((name, i) => ({
      rank: i + 1,
      name,
      share: (bucket.counts.get(i) ?? 0) / sampled,
      energy: Math.round(bucket.energy.get(i) ?? 0),
    }));

    return {
      category: cat.name,
      ranks,
      unranked: (bucket.counts.get(-1) ?? 0) / sampled,
      empty: ranks.filter((r) => r.share === 0).map((r) => r.name),
    };
  });
}
