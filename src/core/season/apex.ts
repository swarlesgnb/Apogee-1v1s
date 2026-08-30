/**
 * Where a score sits at the very top of a board, past where percentiles can see.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The ladder stops measuring on purpose. A scenario's energy caps at its last threshold
 * (`scenarioEnergy`), so two players who both clear the top rank hold identical energy
 * however far apart they actually are. That is the honest thing for a *rank* to do - a
 * rank is a band, and a band has a top - but it leaves the best players with nothing left
 * to move, which is the one group most likely to keep playing.
 *
 * The obvious fix is to keep interpolating past the last threshold at the same slope.
 * That invents a number: the slope past the top is a guess, and nothing checks it. The
 * season's whole claim is that every threshold is a fact about a real board, and a
 * post-rank measure that abandons that is worth less than no post-rank measure.
 *
 * WHY THE EXISTING DISTRIBUTIONS CANNOT DO IT
 *
 * `leaderboard_percentiles.json` samples sixteen points, the finest at the top 0.1%.
 * `scoreAtTopFraction` clamps above it, and so does its inverse - every score in the top
 * 0.1% reports the same 0.001. The Expert window's hardest rank is already the top 0.8%,
 * so the clamp lands *inside* the range a post-rank board exists to separate. Sampling
 * more fractions does not fix it either: fractions get coarser in players exactly where
 * the board gets sparser, and 0.0001 of a 9,878-entry board is one person.
 *
 * SO THE TOP IS SAMPLED IN RANKS, NOT FRACTIONS
 *
 * `leaderboard_apex.json` holds the score at absolute board ranks - 1, 2, 3, 5, 10, 25,
 * 50, 100, 250, 500 - for every scenario the pool names. A rank means the same thing on
 * every board regardless of its size, which is precisely what a fraction stops doing up
 * here, and rank 500 sits below the 0.1% point on every board in the pool, so the two
 * sources overlap rather than leaving a gap between them.
 *
 * Below the last anchor this hands back to the fractional distribution, so one function
 * covers a board from the world record to last place. That matters because the resulting
 * measure is then defined for everybody, not only for players who have maxed the ladder:
 * one board, not a second ladder bolted to the end of the first.
 *
 * Pure. Fetching is `tools/sampleApex.ts`'s job.
 */

import type { Distribution } from "./percentiles.ts";
import { topFractionOfScore } from "./percentiles.ts";

/** One sampled point: the score held by the player at this rank on the board. */
export interface ApexPoint {
  /** 1-based position on the board. Rank 1 is the world record. */
  rank: number;
  score: number;
}

export interface ApexBoard {
  scenario: string;
  leaderboardId: number;
  /** Entries on the leaderboard when it was sampled. */
  total: number;
  /** Ascending by `rank`, so index 0 is the world record. */
  points: ApexPoint[];
  sampledAt: string;
}

/**
 * Ranks to sample, from the world record down.
 *
 * Geometric rather than even, because that is how the curve at the top of a board is
 * shaped: the gap between rank 1 and rank 2 is routinely larger than the gap between
 * rank 100 and rank 250. Ten anchors is enough to interpolate that faithfully and cheap
 * enough that re-running the whole pool is a six minute job.
 *
 * 500 is the last one because it is below the 0.1% point of every board in the pool -
 * the thinnest is 9,878 entries, whose 0.1% is rank 10 - so the fractional distribution
 * is always there to take over underneath.
 */
export const APEX_RANKS = [1, 2, 3, 5, 10, 25, 50, 100, 250, 500];

/**
 * Position on the board for a score, as a real number of ranks from the top.
 *
 * Returns a fractional rank: 12.4 means "between the twelfth and thirteenth best score
 * anybody has posted". Fractional because the anchors are sparse and a step function
 * would let a player gain a hundred points of score for no movement at all, which is the
 * complaint the post-rank board exists to answer.
 *
 * Interpolation is linear in log(rank), not in rank. Between the rank 100 and rank 250
 * anchors a linear-in-rank reading puts the midpoint score at rank 175, where the real
 * board puts it near 158; log spacing matches how the anchors were chosen and how the
 * curve actually falls. Over the 1-to-2 and 2-to-3 gaps the two agree closely, so this
 * costs nothing where the difference would be most visible.
 *
 * Above the world record the answer is rank 1: a score better than the best score ever
 * posted is either a new record or not a score, and `verifyRun` is what decides which.
 */
export function boardRankOfScore(board: ApexBoard, score: number): number | null {
  const points = board.points;
  if (points.length === 0 || !Number.isFinite(score)) return null;

  if (score >= points[0].score) return points[0].rank;

  for (let i = 0; i < points.length - 1; i++) {
    const better = points[i];
    const worse = points[i + 1];
    if (score >= worse.score) {
      const span = better.score - worse.score;
      // A tied anchor pair carries no information about what sits between them, so the
      // worse rank is the honest read: it is the one the score is known to have reached.
      if (span <= 0) return worse.rank;
      const t = (better.score - score) / span;
      const logRank =
        Math.log(better.rank) + t * (Math.log(worse.rank) - Math.log(better.rank));
      return Math.exp(logRank);
    }
  }

  // Below the last anchor. The caller falls back to the fractional distribution.
  return null;
}

/**
 * Fraction from the top of the board, with the top resolved in ranks.
 *
 * This is `topFractionOfScore` with the clamp removed: above the finest sampled fraction
 * it reads the apex anchors instead of flattening. Below them it hands back to the
 * fractional distribution, so a season's thresholds and this measure never disagree about
 * where a mid-board score sits.
 *
 * THE HANDOVER IS FLOORED, AND HAS TO BE
 *
 * The two sources are two samplings of one board and they do not join cleanly. The
 * fractional distribution interpolates linearly in score across gaps as wide as 0.01 to
 * 0.02, and the real curve is convex over that span - `scoreAtTopFraction` says so - so at
 * the last apex anchor the two can differ by a quarter of a percentile. Measured: the
 * worst of the 22 graded boards is tamTargetSwitch Smooth Hard.
 *
 * Left alone that is not merely untidy, it is exploitable in the one direction a standing
 * must never move. Where the distribution reads *better* than the anchor, a player who
 * scored a point less than rank 500 would be placed above rank 500, and dropping score
 * would raise their standing.
 *
 * So below the apex range the answer is floored at the last anchor: a score under the
 * five-hundredth best is, at best, five-hundredth. That is true by construction rather
 * than by interpolation, it makes the combined measure monotone across the whole board,
 * and it costs nothing anywhere else - the floor only binds inside the disagreement.
 *
 * Returns null when neither source can place the score, which is a missing board rather
 * than a bad score and must not be read as "last place".
 */
export function apexTopFraction(
  board: ApexBoard | null,
  dist: Distribution | null,
  score: number,
): number | null {
  let floor: number | null = null;

  if (board && board.total > 0) {
    const rank = boardRankOfScore(board, score);
    if (rank !== null) return rank / board.total;

    const last = board.points[board.points.length - 1];
    floor = last.rank / board.total;
  }

  if (dist) {
    const fraction = topFractionOfScore(dist, score);
    if (fraction === null) return floor;
    return floor === null ? fraction : Math.max(floor, fraction);
  }

  return floor;
}

/**
 * How deep into the top of a board a score sits, as a number that never stops rising.
 *
 * `-log10(topFraction)`, so each whole point means *ten times fewer people above you*:
 *
 *   top 10%      1.0
 *   top 1%       2.0
 *   top 0.1%     3.0
 *   top 0.01%    4.0
 *
 * Three properties earn it the job. It is unbounded upward, so there is always a next
 * thing to chase, which is the entire point. It is defined all the way down the board,
 * so this is one standing that everybody has rather than a second ladder that only
 * unlocks at the top. And a whole point means the same thing everywhere on the scale,
 * which a raw fraction does not: 20% to 10% and 2% to 1% are both one point, and both are
 * genuinely the same achievement expressed as a share of the field.
 *
 * Floored at zero, so the bottom half of a board reads as zero rather than negative.
 * Nobody needs to be told they are minus one.
 */
export function apexPoints(topFraction: number | null): number {
  if (topFraction === null || !Number.isFinite(topFraction) || topFraction <= 0) return 0;
  return Math.max(0, -Math.log10(topFraction));
}
