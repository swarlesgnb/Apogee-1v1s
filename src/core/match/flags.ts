/**
 * Flags: news about your banked rounds.
 *
 * WHAT A FLAG IS, UNDER RANKED V2
 *
 * Every side a player finishes goes into the bank find-match draws opponents from
 * (ranked_pool_rounds), a seeding side included: find-match plants one by itself when the
 * pool has nobody suitable, or when fresh scenarios would serve better (shouldPlantFresh).
 * When somebody later plays a match drawn from your rounds and it settles, that is a
 * Flag: you are told on your next launch, "kestrel played your banked rounds and took 2
 * of 3".
 *
 * WHAT IT IS NOT
 *
 * Not a rating. Ranked v2 rates only the player who played, against the rating their
 * opponent had when those rounds were played (PLAN.md §4), and a stored round answers as
 * many players as draw it, so rating its owner on each would turn one afternoon into ten
 * rating changes. A Flag is the owner hearing about it, nothing more. Not a planting
 * mechanism either: planting is find-match's, unchanged.
 *
 * HOW IT IS READ
 *
 * Derived from rows that already exist: a copy of your side, sitting in somebody else's
 * engine-2 rated match that has settled. Nothing is written when a match settles. The only
 * new state is how far the player has read (flag_reads).
 */

/** How far back a player with no read marker is told about, so a first launch is not a flood. */
export const NEWS_DEFAULT_DAYS = 7;
/** Most news items one read returns. */
export const NEWS_LIMIT = 20;

export interface RoundsTally {
  /** Rounds the player who drew your rounds won. */
  theirs: number;
  /** Rounds your banked rounds held. */
  yours: number;
  tied: number;
}

/**
 * Rounds each way, from the two raw score arrays, by ranked's own rule: the higher score
 * takes the round.
 *
 * Null when the arrays cannot say (a length mismatch), or when they disagree with the
 * verdict settlement stored. They can disagree in one case: a round the player left early
 * a second time in a week counts as lost whatever its partial score was, and the stored
 * scores do not mark that. Then the news says only who won.
 */
export function bankTally(banked: number[], theirs: number[], theirResult: "win" | "loss" | "draw" | null): RoundsTally | null {
  if (banked.length === 0 || banked.length !== theirs.length) return null;
  const t: RoundsTally = { theirs: 0, yours: 0, tied: 0 };
  for (let i = 0; i < banked.length; i++) {
    if (!Number.isFinite(banked[i]) || !Number.isFinite(theirs[i])) return null;
    if (theirs[i] > banked[i]) t.theirs++;
    else if (theirs[i] < banked[i]) t.yours++;
    else t.tied++;
  }
  const implied = t.theirs > t.yours ? "win" : t.theirs < t.yours ? "loss" : "draw";
  return theirResult && implied !== theirResult ? null : t;
}

/** "kestrel played your banked rounds and took 2 of 3." */
export function bankNewsLine(by: string, tally: RoundsTally | null, theirResult: "win" | "loss" | "draw" | null): string {
  if (tally) {
    const rounds = tally.theirs + tally.yours + tally.tied;
    const tied = tally.tied > 0 ? ` (${tally.tied} tied)` : "";
    return `${by} played your banked rounds and took ${tally.theirs} of ${rounds}${tied}.`;
  }
  const how = theirResult === "win" ? "won" : theirResult === "loss" ? "lost" : "drew";
  return `${by} played your banked rounds and ${how}.`;
}

/** The pre-commit line when the queue will hand out a seeding match. */
export function shadowQueueLine(shadowLabel: string, planting: boolean): string {
  const why = planting
    ? "The players near your rating have banked mostly scenarios you just played, so this is three fresh ones."
    : "No one in your band right now.";
  return `${why} You'll face a Shadow now (${shadowLabel}), and your three runs join the bank: ` +
    "whoever draws them later plays you, and you'll hear how it went.";
}
