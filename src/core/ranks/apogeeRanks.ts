/**
 * Apogee's own rank ladder.
 *
 * Deliberately separate from any benchmark's ranks (PLAN.md §4). Voltaic ranks describe
 * benchmark achievement; Apogee ranks describe ladder standing. They are different claims
 * and must never share a vocabulary or a palette.
 *
 * Tiers are assigned by population percentile rather than fixed rating, so the meaning
 * of a tier stays stable as the player base grows and its skill distribution shifts.
 */

import { readFileSync } from "node:fs";

import { dataFile } from "../dataDir.ts";

export interface RankTier {
  id: string;
  name: string;
  /** [inclusiveLower, exclusiveUpper) percentile band, 0..100. */
  percentile: [number, number];
  color: string;
  glow: string;
  gradient: [string, string];
  /**
   * Cap the tier at a fixed number of players, regardless of percentile.
   *
   * A percentile band scales with the population, which is usually what you want but
   * is wrong for a prestige tier: 1% is nobody at 50 players and twenty people at
   * 2,000. Setting `maxHolders` pins the tier to "the top N", the way Top 500 ladders
   * work, so it means the same thing at every population.
   *
   * The percentile band still applies as a floor, so a player must earn the standing
   * as well as place in the top N.
   */
  maxHolders?: number;
  /** Suppresses the "this tier is vanishingly narrow" preflight advisory. */
  deliberatelyNarrow?: boolean;
}

export interface RankTheme {
  version: number;
  placeholderNames: boolean;
  tiers: RankTier[];
}

/** Matches PLAN.md §4: no visible rank until placements are done. */
export const PLACEMENT_MATCHES = 10;

export function loadRankTheme(path?: string | URL): RankTheme {
  const target = path ?? dataFile("apogee_ranks.json");
  const theme = JSON.parse(readFileSync(target, "utf8")) as RankTheme;

  if (!Array.isArray(theme.tiers) || theme.tiers.length === 0) {
    throw new Error("rank theme has no tiers");
  }

  // A gap or overlap in the bands would silently mis-rank players, so fail loudly
  // rather than guessing. This is cheap insurance against a hand-edited file.
  const sorted = [...theme.tiers].sort((a, b) => a.percentile[0] - b.percentile[0]);
  for (let i = 0; i < sorted.length; i++) {
    const [lo, hi] = sorted[i].percentile;
    if (hi <= lo) throw new Error(`tier ${sorted[i].id} has an empty percentile band`);
    if (i === 0 && lo !== 0) throw new Error("rank theme must start at percentile 0");
    if (i > 0 && lo !== sorted[i - 1].percentile[1]) {
      throw new Error(
        `tier ${sorted[i].id} does not start where ${sorted[i - 1].id} ends`,
      );
    }
    if (i === sorted.length - 1 && hi !== 100) {
      throw new Error("rank theme must end at percentile 100");
    }
  }

  return { ...theme, tiers: sorted };
}

/**
 * Tier for a percentile in 0..100, where 100 is the strongest player.
 * Values outside the range are clamped rather than rejected.
 */
export function tierForPercentile(theme: RankTheme, percentile: number): RankTier {
  const p = Math.max(0, Math.min(100, percentile));
  // The top band is closed at 100 so the very best player still lands somewhere.
  for (const tier of theme.tiers) {
    const [lo, hi] = tier.percentile;
    if (p >= lo && (p < hi || hi === 100)) return tier;
  }
  return theme.tiers[theme.tiers.length - 1];
}

/**
 * Percentile of a rating within a population, as a share of players it beats.
 * `population` need not be sorted.
 */
export function percentileOf(rating: number, population: number[]): number {
  if (population.length === 0) return 50;
  let below = 0;
  for (const r of population) if (r < rating) below++;
  return (below / population.length) * 100;
}

export interface RankStanding {
  /** Null while the player is still in placements. */
  tier: RankTier | null;
  percentile: number | null;
  placementsRemaining: number;
  /** Position on the ladder, 1 = best. Only set for capped tiers. */
  ladderPosition?: number;
}

/**
 * Rank a player against the current population.
 *
 * Tiers with a `maxHolders` cap are resolved by ladder position rather than percentile,
 * so "the top three" stays the top three whether there are 200 players or 20,000. A
 * player must clear both the cap and the tier's percentile floor; otherwise a tiny
 * population would hand out the top rank to whoever showed up.
 */
export function standingFor(
  theme: RankTheme,
  rating: number,
  matchesPlayed: number,
  population: number[],
): RankStanding {
  if (matchesPlayed < PLACEMENT_MATCHES) {
    return {
      tier: null,
      percentile: null,
      placementsRemaining: PLACEMENT_MATCHES - matchesPlayed,
    };
  }

  const percentile = percentileOf(rating, population);
  let tier = tierForPercentile(theme, percentile);

  // How many players this one outranks, counting from the top.
  const better = population.filter((r) => r > rating).length;
  const ladderPosition = better + 1;

  const capped = theme.tiers.filter((t) => typeof t.maxHolders === "number");
  if (capped.length > 0) {
    // Capped tiers are checked from the top down: the strictest cap a player clears
    // wins, provided they also meet that tier's percentile floor.
    const ordered = [...capped].sort((a, b) => b.percentile[0] - a.percentile[0]);
    let awarded: RankTier | null = null;

    for (const t of ordered) {
      if (ladderPosition <= (t.maxHolders as number) && percentile >= t.percentile[0]) {
        awarded = t;
        break;
      }
    }

    if (awarded) {
      tier = awarded;
    } else if (capped.includes(tier)) {
      // Percentile alone would have placed them in a capped tier they did not make.
      // Drop to the highest uncapped tier below it.
      const below = [...theme.tiers]
        .filter((t) => !capped.includes(t) && t.percentile[0] < tier.percentile[0])
        .sort((a, b) => b.percentile[0] - a.percentile[0])[0];
      if (below) tier = below;
    }
  }

  return {
    tier,
    percentile,
    placementsRemaining: 0,
    ladderPosition,
  };
}
