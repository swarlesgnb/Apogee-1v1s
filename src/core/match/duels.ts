/**
 * When a duel may be answered, and by whom.
 *
 * A duel is a match somebody addressed at a named player rather than at the pool. The
 * challenger plays the three scenarios first, exactly as a seeding match does today; the
 * recipient answers, and accepting creates an ordinary contested match pinned to the
 * challenger's stored side. Nothing about settlement, rating or verification changes -
 * this file decides only whether the answer is allowed.
 *
 * WHY THIS IS SEPARATE FROM THE FUNCTION THAT SERVES IT
 *
 * Every rule below is a refusal, and a refusal that is wrong in the permissive direction
 * is a rated result somebody did not agree to: a duel answered twice, answered by the
 * wrong account, or accepted after it expired. Those are cheap to get right in a pure
 * function against a table of cases and expensive to get right by reading an Edge
 * Function, so the decision lives here and the function does the writing.
 *
 * WHAT IS NOT STORED
 *
 * "The challenger has not finished playing yet" is derived from their side of the match
 * carrying no score, never written down. A stored copy is a second source of truth about
 * a match this file does not own, and the two would drift the first time a run landed
 * late.
 */

/**
 * How long a duel waits.
 *
 * Days, not minutes, and deliberately a different order of magnitude from a match's own
 * deadline: `INITIAL_TTL_MS` in find-match is eight minutes because that is how long you
 * get to play three scenarios once a match is open, whereas waiting is the entire point
 * of a duel. Seven days is a week of evenings, which is the unit somebody who plays after
 * work actually has.
 *
 * Here rather than in the Edge Function's shared module because the client shows the
 * remaining time too, and a deadline the two disagree about is a countdown that ends at
 * the wrong moment.
 */
export const DUEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type DuelStatus = "open" | "accepted" | "declined" | "expired";

export type DuelAnswer = "accept" | "decline";

export interface Duel {
  id: string;
  fromPlayer: string;
  toPlayer: string;
  status: DuelStatus;
  expiresAt: Date;
  /**
   * The challenger's own score on the three scenarios, or null while they are still
   * playing them. Read from their `match_sides` row rather than copied.
   */
  challengerMatchScore: number | null;
}

export interface DuelRefused {
  ok: false;
  /** Shown to the player, so it says what happened rather than which branch fired. */
  reason: string;
}

export interface DuelAllowed {
  ok: true;
  status: Extract<DuelStatus, "accepted" | "declined">;
}

export type DuelDecision = DuelRefused | DuelAllowed;

/** Past its deadline, whatever the stored status still says. */
export function duelExpired(duel: Duel, now: Date = new Date()): boolean {
  return duel.expiresAt.getTime() <= now.getTime();
}

/**
 * Sent, but the challenger has not played their three scenarios yet.
 *
 * Worth showing in the inbox rather than hiding: "someone has challenged you and is
 * playing it now" is the most interesting thing that can be on that screen, and a duel
 * that appeared only once it was answerable would look like it arrived out of nowhere.
 */
export function duelWaiting(duel: Duel): boolean {
  return duel.challengerMatchScore === null;
}

/**
 * May this player answer this duel, and how.
 *
 * Order matters. Identity is checked before state so that a stranger poking at somebody
 * else's duel is told it is not theirs rather than told its status, and expiry is checked
 * before the waiting rule so a long-dead duel does not report as "still playing".
 */
export function answerDuel(
  duel: Duel,
  byPlayer: string,
  answer: DuelAnswer,
  now: Date = new Date(),
): DuelDecision {
  if (byPlayer === duel.fromPlayer) {
    return { ok: false, reason: "you sent this duel, so it is not yours to answer" };
  }
  if (byPlayer !== duel.toPlayer) {
    return { ok: false, reason: "this duel was not sent to you" };
  }

  if (duel.status === "accepted") return { ok: false, reason: "you have already accepted this duel" };
  if (duel.status === "declined") return { ok: false, reason: "you have already declined this duel" };
  if (duel.status === "expired") return { ok: false, reason: "this duel has expired" };

  if (duelExpired(duel, now)) return { ok: false, reason: "this duel has expired" };

  // Declining early is allowed and accepting early is not. Saying no costs nothing and
  // should never require waiting on somebody else to finish playing; saying yes creates a
  // match against deltas that do not exist yet, which would settle against zeros.
  if (answer === "accept" && duelWaiting(duel)) {
    return { ok: false, reason: "they have not finished playing this duel yet" };
  }

  return { ok: true, status: answer === "accept" ? "accepted" : "declined" };
}

/**
 * May this player send this duel?
 *
 * The eligibility bar is not here: it is `queueEligibility`, it is enforced on both ends
 * by the functions, and duplicating the number is how a readout and a refusal drift
 * apart. What this owns is the pairing itself.
 */
export function canSendDuel(fromPlayer: string, toPlayer: string): DuelDecision {
  if (fromPlayer === toPlayer) {
    return { ok: false, reason: "you cannot duel yourself" };
  }
  return { ok: true, status: "accepted" };
}

/** The status a stored duel should be read as, applying expiry without writing it. */
export function effectiveStatus(duel: Duel, now: Date = new Date()): DuelStatus {
  if (duel.status === "open" && duelExpired(duel, now)) return "expired";
  return duel.status;
}
