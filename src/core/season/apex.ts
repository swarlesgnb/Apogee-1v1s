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
import { scoreAtTopFraction, topFractionOfScore } from "./percentiles.ts";

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

  // Strictly better than the world record is rank 1. Equal to it is not, where somebody
  // else already holds the same score: the same tie rule as below, and it matters most here
  // because the top rank of a season is held by place on this board.
  if (score > points[0].score) return points[0].rank;
  if (score === points[0].score) {
    let at = 0;
    while (points[at + 1]?.score === score) at++;
    return points[at].rank;
  }

  for (let i = 0; i < points.length - 1; i++) {
    const better = points[i];
    let worse = points[i + 1];
    if (score >= worse.score) {
      // A score that ties an anchor ties everyone down to the last anchor holding the same
      // score, and the anchors say nothing about who sits between them. The worse rank is
      // the honest read: it is the one the score is *known* to have reached.
      //
      // The tie has to be walked forward, not just noticed. 1w2ts Pasu Perfected 30%
      // Smaller has ranks 3 and 5 both at 114, and a score of 114 lands on the 120-to-114
      // pair one step earlier - where the span is six, not zero - so interpolating there
      // returned rank 3 and never reached the tied pair at all. That overstates a position,
      // which is the direction that matters: the top rank of a season is held by place on
      // this board, and handing it to somebody tied at fifth is the failure this measure
      // exists to avoid.
      while (worse.score === score && points[i + 2]?.score === score) {
        i++;
        worse = points[i + 1];
      }
      if (score === worse.score) return worse.rank;

      const span = better.score - worse.score;
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
 * The score it takes to reach a given position on the board.
 *
 * `boardRankOfScore` run backwards, and it exists because a board people are supposed to
 * chase has to be able to name what they are chasing. "You are 7,307th" is a fact; "1,240
 * more takes you into the top 1%" is a reason to load the scenario.
 *
 * Same log-rank interpolation as the forward direction, so the two agree in the direction
 * that matters: the score returned reaches AT LEAST the rank asked for. Not exactly it -
 * board scores are integers and the top of a board ties constantly, with 53 at both rank 1
 * and rank 2 on tamTargetSwitch Control Hard, so no score identifies rank 1.5 at all. Where
 * a tie makes the answer generous it is generous, never short, and `validateStanding`
 * asserts that one-sided property rather than a round trip the data cannot support.
 *
 * Which means a tie has to be climbed out of, not interpolated across. Asking for rank 1.5
 * on that board interpolates between 53 and 53 and gets 53 - and 53 is rank 2, because
 * `boardRankOfScore` resolves a tie to the worse rank it is known to reach. Naming 53 as
 * the way to rank 1.5 is precisely the broken promise the paragraph above says not to make,
 * so the answer steps up to the next score the anchors distinguish.
 *
 * Null when the rank is past the last anchor, where the apex board has no opinion and the
 * fractional distribution is the thing to ask - and null too when a tie at the top means no
 * score the board knows reaches the rank asked for.
 */
export function scoreAtBoardRank(board: ApexBoard, rank: number): number | null {
  const points = board.points;
  if (points.length === 0 || !Number.isFinite(rank)) return null;

  // Better than the world record is the world record's score: nothing above it is known.
  if (rank <= points[0].rank) return clearOfTies(board, points[0].score, rank);

  for (let i = 0; i < points.length - 1; i++) {
    const better = points[i];
    const worse = points[i + 1];
    if (rank <= worse.rank) {
      const span = Math.log(worse.rank) - Math.log(better.rank);
      const raw =
        span <= 0
          ? worse.score
          : better.score +
            ((Math.log(rank) - Math.log(better.rank)) / span) * (worse.score - better.score);
      return clearOfTies(board, raw, rank);
    }
  }

  return null;
}

/**
 * Raise a score until it actually reads back at the rank it is being offered for.
 *
 * Only ever moves up, and only ever to a score the anchors already contain, so nothing here
 * invents precision the board does not have. On a board with no tie at the asked rank the
 * first read already passes and this returns what it was given.
 */
function clearOfTies(board: ApexBoard, score: number, rank: number): number | null {
  let out = score;
  for (let guard = 0; guard < board.points.length; guard++) {
    const back = boardRankOfScore(board, out);
    if (back === null || back <= rank + 0.01) return out;
    const next = board.points
      .map((p) => p.score)
      .filter((sc) => sc > out)
      .sort((a, b) => a - b)[0];
    // Nothing left to climb to. Ten of the pool's boards have their world record held by
    // two people at once, and on those there is no score the anchors know that reaches rank
    // 1.5 - beating the tie means setting a new record, and above the record the board has
    // no opinion at all. That is the same "ask the fractional distribution" answer null
    // already means everywhere else, and it beats naming a score that does not do it.
    if (next === undefined) return null;
    out = next;
  }
  return out;
}

/**
 * The next whole apex point, and what it costs.
 *
 * A whole point is the unit the board is denominated in - ten times fewer people above
 * you - so it is the natural next thing to aim at, and unlike a round rank it means the
 * same amount of work wherever a player currently sits.
 *
 * Returns null where the target is off the top of the sampled board: past the world record
 * there is nothing to promise, and saying so beats inventing a number.
 */
export function nextWholePoint(
  board: ApexBoard | null,
  dist: Distribution | null,
  currentPoints: number,
): { points: number; score: number; rank: number } | null {
  const target = Math.floor(currentPoints) + 1;
  const fraction = Math.pow(10, -target);

  if (board && board.total > 0) {
    const rank = fraction * board.total;
    // Above the world record: no score reaches it, so there is nothing to name.
    if (rank < board.points[0].rank) return null;

    // Inside the sampled top, the board is the authority and its silence is an answer.
    // Falling through to the fractional curve here was wrong in the one case it fires: a
    // board whose record is held by two people cannot name a score for the rank just below
    // it, and the coarse curve happily names one anyway - a score the player has often
    // already beaten. A target behind you is worse than no target.
    if (rank <= board.points[board.points.length - 1].rank) {
      const score = scoreAtBoardRank(board, rank);
      return score === null ? null : { points: target, score, rank };
    }
  }

  if (dist) {
    const score = scoreAtTopFraction(dist, fraction);
    if (score !== null) return { points: target, score, rank: fraction * dist.total };
  }

  return null;
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
