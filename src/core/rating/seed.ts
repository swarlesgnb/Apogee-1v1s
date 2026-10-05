/**
 * A first rating from what KovaaK's already vouches for.
 *
 * Every new player used to start at 1500 / RD 350 and find their level through
 * placements. That was tolerable while a match was decided on deltas, which do not
 * depend on how good anybody is. Ranked is decided on raw score now (PLAN.md §3), so a
 * strong newcomer at 1500 beats everybody near 1500 for ten matches, and the people they
 * beat lose rating to a mismatch nobody chose.
 *
 * So a player starts where their verified PBs put them on the season's own thresholds.
 * Verified, never local: a rating seeded from scores the client uploaded could be
 * talked down by playing badly first, which is the sandbagging exploit (§3) moved from
 * baselines to ratings. KovaaK's servers are the referee (§5).
 */

import { ENERGY_PER_RANK, scenarioEnergy } from "../benchmarks/energy.ts";
import { defaultRating, type Rating } from "./glicko2.ts";

/** One scenario of the season, as `season_scenarios` stores it. */
export interface StandingScenario {
  scenarioId: number;
  /** Null on a flat season, where each scenario is its own family. */
  family: string | null;
  windowIndex: number;
  rankMaxes: number[];
}

/**
 * Fewest families with a verified PB before a standing is trusted.
 *
 * One or two is a player who tried a scenario, not a measurement of them, and a seed is
 * a claim about where somebody belongs. Below this they start at the default and find
 * their level the old way.
 */
export const MIN_FAMILIES_FOR_STANDING = 3;

/** The range a standing of 0..1 maps onto, centred on the default rating. */
const SEED_LOW = 1100;
const SEED_HIGH = 1900;

/**
 * Seeded players are not unknowns, so they start more certain than a blank account's
 * 350. Still well above a settled player's (the simulated season in validateMatch settles
 * under 120), because a seed is read off thresholds, not off anybody played against, and
 * placements have to be able to move it a long way.
 */
export const SEED_RD = 200;

/**
 * How far up the season's ladder a player's verified PBs reach, 0..1, or null when too
 * few families have one.
 *
 * Per family, the best of its variants, the way the grading engine takes it (energy.ts
 * evaluateFamily): a variant contributes `windowIndex * windowSize` ranks below it plus
 * its own fractional rank, and a variant above window 0 says nothing below its own
 * first threshold. The standing is the mean over families of that rank divided by the
 * ladder's depth.
 */
export function seasonStanding(
  scenarios: StandingScenario[],
  verifiedPbs: Map<number, number>,
  windowSize: number | null,
): { standing: number; families: number } | null {
  const families = new Map<string, { best: number; depth: number }>();

  for (const s of scenarios) {
    if (s.rankMaxes.length === 0) continue;
    const key = s.family ?? `#${s.scenarioId}`;
    const offset = windowSize ? s.windowIndex * windowSize : 0;
    const entry = families.get(key) ?? { best: -1, depth: 0 };
    entry.depth = Math.max(entry.depth, offset + s.rankMaxes.length);

    const pb = verifiedPbs.get(s.scenarioId);
    if (pb !== undefined && pb > 0 && (offset === 0 || pb >= s.rankMaxes[0])) {
      const ranks = offset + scenarioEnergy(pb, s.rankMaxes) / ENERGY_PER_RANK;
      entry.best = Math.max(entry.best, ranks);
    }
    families.set(key, entry);
  }

  const measured = [...families.values()].filter((f) => f.best >= 0 && f.depth > 0);
  if (measured.length < MIN_FAMILIES_FOR_STANDING) return null;

  const standing = measured.reduce((sum, f) => sum + Math.min(1, f.best / f.depth), 0) / measured.length;
  return { standing, families: measured.length };
}

/** The rating a standing seeds, or the default when there is no standing. */
export function seedRating(standing: number | null): Rating {
  if (standing === null || !Number.isFinite(standing)) return defaultRating();
  const clamped = Math.min(1, Math.max(0, standing));
  return {
    rating: SEED_LOW + clamped * (SEED_HIGH - SEED_LOW),
    rd: SEED_RD,
    volatility: defaultRating().volatility,
  };
}
