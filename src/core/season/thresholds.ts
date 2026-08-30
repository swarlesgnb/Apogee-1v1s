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
 *   seeded      carried over from the percentile era and not yet given a source. A debt,
 *               counted and printed on every run so it cannot be forgotten.
 *   authored    nobody published it, so somebody decided it. Requires a written reason.
 *
 * `npm run validate:thresholds` re-derives the first two, demands a reason for the fourth,
 * and burns the third down. The point is not that authored numbers are bad - a benchmark is
 * a set of opinions about what is worth achieving - but that the reader can always tell
 * which kind they are looking at.
 */

/** One published source: a benchmark tier that names this scenario with scores. */
export interface ThresholdCitation {
  benchmark: string;
  difficulty: string;
  /** The full array that benchmark publishes, so a checker needs nothing else. */
  rankMaxes: number[];
}

export type ThresholdSource =
  | { kind: "adopted"; from: ThresholdCitation[] }
  | { kind: "reconciled"; rule: string; from: ThresholdCitation[] }
  | { kind: "seeded"; note: string }
  | { kind: "authored"; why: string };

/** A source that has stopped being a debt. */
export function isSourced(source: ThresholdSource | undefined): boolean {
  return source !== undefined && source.kind !== "seeded";
}

/**
 * Is `values` a contiguous run of `published`?
 *
 * "Adopted" cannot mean "equal", because a window is `windowSize` ranks and a benchmark tier
 * is however many its author chose - Voltaic S5 Advanced publishes four, Viscose Hard six.
 * Taking four of Viscose's six is still adopting Viscose's numbers; inventing a fifth is
 * not. So the test is containment as a run, which distinguishes those two cases and nothing
 * else.
 */
export function isRunOf(values: number[], published: number[]): boolean {
  if (values.length === 0 || values.length > published.length) return false;

  for (let start = 0; start + values.length <= published.length; start++) {
    let all = true;
    for (let i = 0; i < values.length; i++) {
      if (published[start + i] !== values[i]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Does the number match what its source claims?
 *
 * Returns null when it does, or a sentence saying how it does not. Only `adopted` and
 * `reconciled` are checkable here - the other two are checked for having a reason at all,
 * which is a different question and lives in the validator.
 */
export function checkAgainstSource(
  values: number[],
  source: ThresholdSource,
): string | null {
  if (source.kind === "adopted") {
    if (source.from.length !== 1) {
      return `adopted from ${source.from.length} sources; adopted means exactly one, use reconciled`;
    }
    const cited = source.from[0];
    return isRunOf(values, cited.rankMaxes)
      ? null
      : `does not appear in ${cited.benchmark} ${cited.difficulty}, which publishes [${cited.rankMaxes.join(", ")}]`;
  }

  if (source.kind === "reconciled") {
    if (source.from.length < 2) {
      return "reconciled from fewer than two sources; one source is adopted, not reconciled";
    }
    // The rule itself is applied by tools/adoptThresholds.ts. What is checked here is that
    // the result is bracketed by the sources it claims to reconcile - a reconciliation that
    // lands outside every number it was reconciling is not one.
    for (let i = 0; i < values.length; i++) {
      const at = source.from
        .map((c) => c.rankMaxes[i])
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
