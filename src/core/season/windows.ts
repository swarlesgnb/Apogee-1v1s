/**
 * Which ranks a window grades.
 *
 * A season's ladder is one sequence of ranks cut into windows, and each window carries one
 * variant per family: harder scenarios as the ranks get harder, so a ladder wide enough for
 * a first-week player and a good one does not have to be one set of scenarios.
 *
 * WHY WINDOWS OVERLAP
 *
 * They used to abut. Window 1 graded ranks 5 to 8 and stopped, so a player on the
 * Intermediate scenarios could not be shown as anything better than the eighth rank however
 * well they did - the ninth was Advanced's to give, and reaching it meant launching a
 * scenario they had never opened. That is a cliff at every handover, three times up the
 * ladder, and it lands exactly where a player is most likely to quit.
 *
 * So a window now reaches `overlap` ranks into the one above: window w grades ranks
 * `w * windowSize` through `w * windowSize + windowSize + overlap - 1`, clamped to the end
 * of the ladder. With four-rank windows and an overlap of two, Intermediate grades ranks 5
 * to 10 - it can award Greyhound - and Advanced grades 9 to 14, so the two of them both
 * speak for ranks 9 and 10 and a player crosses over whenever the harder scenarios start
 * paying better.
 *
 * Nothing about grading changes: `energy.ts` offsets a variant by `window * windowSize` and
 * takes the best variant a family has, which already resolves an overlap in the player's
 * favour. What changes is that a variant carries more thresholds than a window has stride,
 * so anything that assumed `rankMaxes.length === windowSize` has to ask here instead.
 *
 * The top window is short by the overlap - it has nothing above to reach into - which is why
 * this is a function and not an addition.
 */

/** How many ranks the window grades, counting the overlap into the window above. */
export function windowRankCount(
  window: number,
  windowSize: number,
  totalRanks: number,
  overlap: number,
): number {
  const first = window * windowSize;
  if (first >= totalRanks) return 0;
  return Math.min(windowSize + overlap, totalRanks - first);
}

/** Global rank indices this window grades, zero-based, ascending. */
export function windowRankIndices(
  window: number,
  windowSize: number,
  totalRanks: number,
  overlap: number,
): number[] {
  const first = window * windowSize;
  const count = windowRankCount(window, windowSize, totalRanks, overlap);
  return Array.from({ length: count }, (_, i) => first + i);
}

/**
 * The lowest window that grades a rank, which is the one a player climbing the ladder meets
 * first.
 *
 * Overlapping windows mean two of them can, and naming the harder one is the mistake worth
 * avoiding: "you need 4,180 on Smoothbot rAim" for the next rank, said to somebody who has
 * only ever launched the Intermediate variant that also grades it, is the confusing thing
 * the overlap was introduced to remove.
 */
export function windowForRank(rank: number, windowSize: number, overlap: number): number {
  return Math.max(0, Math.ceil((rank - windowSize - overlap + 1) / windowSize));
}
