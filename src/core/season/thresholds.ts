/**
 * Where a rank's score came from.
 *
 * WHY A SEASON STOPPED DERIVING ITS OWN NUMBERS
 *
 * Every threshold used to be a percentile of a KovaaK's leaderboard: rank 7 was "the score
 * at the top 10% of this board". That is defensible for a *ranking* ladder - it is grounded,
 * it needs no authority, and "why is Diamond 930" has an answer that is a fact rather than
 * an opinion.
 *
 * It is the wrong instrument for a benchmark whose job is improvement. A percentile moves
 * when the population moves, so the target slides while somebody is chasing it; and a rank
 * cut from a population is a statement about other people rather than about the skill. The
 * benchmarks players actually train against - Voltaic, Viscose, Revosect, Aimerz+ - all
 * publish hard scores, and hard scores are what a person can aim at.
 *
 * So a threshold is now an authored number. The risk that creates is obvious: an authored
 * number is an opinion, and an opinion with no provenance is indistinguishable from a
 * guess. That is what this file exists to prevent.
 *
 * EVERY NUMBER IS EITHER A CITATION OR AN ADMISSION
 *
 *   adopted     it equals what a named benchmark publishes for that scenario. Re-derivable
 *               from data/benchmarks/*.json to the digit.
 *   reconciled  several benchmarks publish it and they disagree; the number is a stated
 *               function of the cited ones. Also re-derivable to the digit.
 *   percentile  cut from this scenario's own KovaaK's board at a stated share of it. Also
 *               re-derivable to the digit, against the sampled distribution.
 *   seeded      carried over from the percentile era and not yet given a source. A debt,
 *               counted and printed on every run so it cannot be forgotten.
 *   authored    nobody published it, so somebody decided it. Requires a written reason.
 *
 * `npm run validate:thresholds` re-derives the first three, demands a reason for the last,
 * and burns `seeded` down. The point is not that authored numbers are bad - a benchmark is
 * a set of opinions about what is worth achieving - but that the reader can always tell
 * which kind they are looking at.
 *
 * WHY `percentile` IS BACK, WHEN THE FIRST PARAGRAPH SAYS IT WENT AWAY
 *
 * Because the objection was to deriving at *read* time, not to a percentile being the
 * reason a number is what it is. A pool of 264 hand-picked scenarios has no published tier
 * for most of them - they are community variants nobody graded, which is the whole reason
 * they are worth having - so the choice is between a percentile written down once and a
 * number somebody typed. Written down once, the target sits still: it is a fact about the
 * board on the day it was sampled, it is stamped with that day, and re-cutting it is a
 * deliberate act with a diff. That is a different thing from a threshold that moves under a
 * player between two Tuesdays.

/** One published source: a benchmark tier that names this scenario with scores. */
export interface ThresholdCitation {
  benchmark: string;
  difficulty: string;
  /** The full array that benchmark publishes, so a checker needs nothing else. */
  rankMaxes: number[];
  /**
   * The `windowSize` of those the reconciliation actually used.
   *
   * A tier can publish more ranks than a window has, so the picks are spread across it
   * - and then rank 2 of the window is not rank 2 of the published array. Comparing
   * those two positions is a real bug this field exists to close: it reported six
   * correctly-reconciled numbers as outside their sources, because it was bracketing
   * window rank 2 against published rank 2 rather than against the picks either side
   * of it. Absent when the tier was used whole.
   */
  used?: number[];
}

/**
 * The ranks a window grades past the last one anybody published for it.
 *
 * A benchmark tier is its author's whole ladder for that band - Voltaic Advanced publishes
 * four numbers - and a window grades six, because it reaches two ranks into the one above.
 * Nobody published those two for this scenario, so they have to come from somewhere, and
 * the choice is not obvious.
 *
 * Cutting them from the scenario's own board was tried first and is wrong: measured across
 * the pool it collapsed 12 of 16 extended windows, because a benchmark's top rank for a
 * band is consistently harder than this ladder's share for the two ranks above it, so the
 * cut landed *below* the number it was supposed to continue from and got floored to a
 * one-point step. Two ranks a single point apart is two ranks nobody holds separately.
 *
 * So the tail continues the author's own ladder at the author's own step: the geometric
 * mean of the ratios inside their published tier, applied twice. That keeps a window on one
 * scale rather than splicing two instruments together in the middle of it, and `ratio` is
 * re-derivable from the citation the source already carries.
 *
 * It is still an extrapolation, and it is honest that it is one. The alternative - letting
 * an adopted variant grade only the four ranks its author published - was rejected because
 * it would mean the families a benchmark covers are exactly the families that keep the
 * handover cliff the overlap exists to remove.
 */
export interface ExtendedTail {
  /** Global rank indices the tail covers, zero-based, ascending. */
  ranks: number[];
  /** Per-rank multiplier, continued from the cited tier. */
  ratio: number;
  rule: string;
}

/** A cut from one scenario's own leaderboard, carrying everything needed to redo it. */
export interface PercentileCut {
  /** Global rank indices this variant grades, zero-based. */
  ranks: number[];
  /** Share of the board each of those ranks asks for, in the same order. */
  topFractions: number[];
  leaderboardId: number | null;
  /** Entries on the board when it was sampled, and when. Both are why the numbers moved. */
  total: number;
  sampledAt: string;
}

export type ThresholdSource =
  | { kind: "adopted"; from: ThresholdCitation[]; extended?: ExtendedTail }
  | { kind: "reconciled"; rule: string; from: ThresholdCitation[]; extended?: ExtendedTail }
  | { kind: "percentile"; cut: PercentileCut; why: string }
  | { kind: "seeded"; note: string }
  | { kind: "authored"; why: string }
  | { kind: "predicted"; why: string };

/** A source that has stopped being a debt. */
export function isSourced(source: ThresholdSource | undefined): boolean {
  return source !== undefined && source.kind !== "seeded";
}

/**
 * Is every value in `values` one `published` gives, in the same order?
 *
 * "Adopted" cannot mean "equal", because a window is `windowSize` ranks and a benchmark tier
 * is however many its author chose - Voltaic S5 Advanced publishes four, Viscose Hard six.
 * Taking four of Viscose's six is still adopting Viscose's numbers; inventing a fifth is not.
 *
 * A subsequence rather than a contiguous run, because four ranks taken from six should span
 * the range the author meant that tier to cover - first and last included - and evenly
 * spaced picks are not adjacent. What the test still guarantees is the thing that matters:
 * every number is one the named author published for this scenario, in the order they
 * published it. Nothing here was interpolated, averaged or nudged.
 */
export function isSubsequenceOf(values: number[], published: number[]): boolean {
  if (values.length === 0 || values.length > published.length) return false;

  let at = 0;
  for (const v of values) {
    while (at < published.length && published[at] !== v) at++;
    if (at >= published.length) return false;
    at++;
  }
  return true;
}

/**
 * Does the number match what its source claims?
 *
 * Returns null when it does, or a sentence saying how it does not. Only `adopted` and
 * `reconciled` are checkable here, because they need nothing but the citation they carry.
 * `percentile` is checkable too but needs the sampled board, so it is re-cut in the
 * validator; the other two are checked for having a reason at all, which is a different
 * question and lives there as well.
 */
export function checkAgainstSource(
  values: number[],
  source: ThresholdSource,
): string | null {
  // Only the published prefix is the author's. Where a window reaches past their tier, the
  // tail is a percentile cut with its own record, and holding it to the citation would
  // report every extended variant as wrong.
  if (
    (source.kind === "adopted" || source.kind === "reconciled") &&
    source.extended &&
    source.extended.ranks.length > 0
  ) {
    values = values.slice(0, values.length - source.extended.ranks.length);
  }

  if (source.kind === "adopted") {
    if (source.from.length !== 1) {
      return `adopted from ${source.from.length} sources; adopted means exactly one, use reconciled`;
    }
    const cited = source.from[0];
    return isSubsequenceOf(values, cited.rankMaxes)
      ? null
      : `is not drawn from ${cited.benchmark} ${cited.difficulty}, which publishes [${cited.rankMaxes.join(", ")}]`;
  }

  if (source.kind === "reconciled") {
    if (source.from.length < 2) {
      return "reconciled from fewer than two sources; one source is adopted, not reconciled";
    }
    // The rule itself is applied by tools/adoptThresholds.ts. What is checked here is that
    // the result is bracketed by the sources it claims to reconcile - a reconciliation that
    // lands outside every number it was reconciling is not one.
    for (let i = 0; i < values.length; i++) {
      // `used` where the tier was reduced to fit the window, the published array where
      // it fitted already. Comparing against the wrong one compares two different ranks.
      const at = source.from
        .map((c) => (c.used ?? c.rankMaxes)[i])
        .filter((n): n is number => typeof n === "number");
      if (at.length === 0) continue;
      const lo = Math.min(...at);
      const hi = Math.max(...at);
      if (values[i] < lo || values[i] > hi) {
        return `rank ${i + 1} is ${values[i]}, outside the ${lo}-${hi} its sources give`;
      }
    }
    return null;
  }

  return null;
}
