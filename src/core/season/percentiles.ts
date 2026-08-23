/**
 * Score distributions, and thresholds derived from them.
 *
 * A rank should mean "you are better at this than N% of the people who play it". That is
 * what PLAN.md §14 asks for, and the reason it was deferred was that Apogee has no
 * population yet to take percentiles of.
 *
 * It does not need one. KovaaK's publishes a global leaderboard per scenario, and those
 * leaderboards are large - 79,756 entries on one of the six Clicking scenarios - and are
 * the game's own population rather than any benchmark author's opinion of it. Sampling
 * them gives thresholds that are:
 *
 *   OURS       the percentiles are Apogee's choice; the scores are a fact about the game
 *   GROUNDED   "why is rank 7 at 929" has an answer: it is the top 10% of that ladder
 *   AVAILABLE  now, rather than after a population exists
 *
 * The one thing to be careful about is what a percentile is a percentile *of*. A
 * leaderboard holds the people who played that scenario, not everybody - so the
 * population on a harder scenario is smaller and stronger, and a percentile does not mean
 * the same thing across two of them. Thresholds are therefore derived per scenario and
 * compared only within a window; how one window chains into the next stays a judgement
 * about scenario design, checkable against Apogee's own population at the next rollover.
 *
 * Pure. Fetching is the caller's job, so this is testable without a network.
 */

/** One sampled point: the score at a given percentile from the top. */
export interface DistributionPoint {
  /** Fraction from the top, 0..1. 0.1 means "the score at rank 10% down the board". */
  topFraction: number;
  score: number;
}

export interface Distribution {
  scenario: string;
  leaderboardId: number;
  /** Entries on the leaderboard when it was sampled. */
  total: number;
  /** Ascending by `topFraction`, so index 0 is the strongest sampled score. */
  points: DistributionPoint[];
  sampledAt: string;
}

/**
 * Score at an arbitrary percentile, interpolated between sampled points.
 *
 * Linear in score against fraction. The curve is convex, so interpolating over a wide gap
 * understates the score; the sampler places points densely at the top, where the curve
 * bends hardest and where the ranks people care about live.
 */
export function scoreAtTopFraction(dist: Distribution, topFraction: number): number | null {
  const points = dist.points;
  if (points.length === 0) return null;

  if (topFraction <= points[0].topFraction) return points[0].score;
  const last = points[points.length - 1];
  if (topFraction >= last.topFraction) return last.score;

  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1];
    if (topFraction <= hi.topFraction) {
      const span = hi.topFraction - lo.topFraction;
      if (span <= 0) return lo.score;
      const t = (topFraction - lo.topFraction) / span;
      return lo.score + t * (hi.score - lo.score);
    }
  }

  return last.score;
}

/**
 * Where a score sits on the board, as a fraction from the top.
 *
 * The inverse of the above, and the thing that makes another benchmark usable as a
 * *reference* rather than a source: it answers "what percentile did they put that
 * threshold at" without adopting the number.
 */
export function topFractionOfScore(dist: Distribution, score: number): number | null {
  const points = dist.points;
  if (points.length === 0) return null;

  if (score >= points[0].score) return points[0].topFraction;
  const last = points[points.length - 1];
  if (score <= last.score) return last.topFraction;

  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1];
    // Scores descend as the fraction grows.
    if (score >= hi.score) {
      const span = lo.score - hi.score;
      if (span <= 0) return lo.topFraction;
      const t = (lo.score - score) / span;
      return lo.topFraction + t * (hi.topFraction - lo.topFraction);
    }
  }

  return last.topFraction;
}

/**
 * Thresholds for one window, ascending.
 *
 * `ladder` is the percentiles for the window's ranks, easiest first. Rounding is to a
 * whole point because a threshold with a decimal in it looks like a measurement error to
 * a player reading it, and the precision is not real anyway.
 */
export function thresholdsFrom(
  dist: Distribution,
  ladder: number[],
): number[] | null {
  const out: number[] = [];

  for (const topFraction of ladder) {
    const score = scoreAtTopFraction(dist, topFraction);
    if (score === null) return null;
    out.push(Math.round(score));
  }

  // Ties are real: two adjacent percentiles can land on the same score where the board is
  // dense. A flat step would make a rank unreachable-by-definition, so each is nudged past
  // the last. One point is honest about the size of the correction.
  for (let i = 1; i < out.length; i++) {
    if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 1;
  }

  return out;
}
