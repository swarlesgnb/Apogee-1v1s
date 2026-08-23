/**
 * Who is allowed to queue.
 *
 * The ladder is only worth anything if the account playing on it has a history behind
 * it. Nothing else here stops someone installing the app on a fresh Steam account,
 * queueing immediately against a real player, and treating the loss as free - and doing
 * that repeatedly is how a rating distribution gets quietly poisoned from the bottom.
 *
 * So queueing costs a history: `MIN_RUNS_TO_QUEUE` runs uploaded and not rejected.
 *
 * WHERE THE NUMBER COMES FROM
 *
 * Measured against this machine's 11,427-run corpus rather than picked. Counting from
 * the first run ever recorded:
 *
 *     25 runs    day 0      1 day played
 *     50 runs    day 1      2 days played
 *    100 runs    day 3      3 days played
 *    500 runs    day 12    11 days played
 *
 * with a median of 42 runs on any day the game was opened at all, and 207 on the
 * busiest. So 100 runs is two or three ordinary sessions for somebody who wants to
 * play, and about two and a half hours of actual aiming for somebody who only wants a
 * fresh rating. That is the honest size of this: a speed bump, not a wall.
 *
 * WHAT IT IS NOT
 *
 * It is not an anti-forgery check, and must not be sold as one. A run's filename carries
 * a bare local wall clock, so a fabricated history can claim any dates it likes, and the
 * volume itself proves only that files exist.
 *
 * The check that cannot be forged is the `verified` tier: KovaaK's own servers hold a
 * record for that SteamID with the same hash and challenge start. Requiring one of those
 * to queue is the obvious next step and deliberately is not done here, because it does
 * not work yet: backfilled runs are stored `unverified` (verification currently runs on
 * match submission only), and of the 11,116 runs uploaded to the live project today,
 * exactly 0 carry `verified`. Shipping that condition now would refuse every player,
 * including the only one who exists.
 *
 * Pure, and shared by the client that renders the progress and the Edge Function that
 * enforces it - one number, in one place, so the readout and the refusal cannot drift.
 */

/**
 * Uploaded runs needed before a player may queue.
 *
 * Counts runs that were not rejected, which is every run for an honest player: a
 * rejection means the file failed local integrity, and those are excluded so that
 * uploading garbage cannot buy a ticket.
 */
export const MIN_RUNS_TO_QUEUE = 100;

export interface QueueEligibility {
  eligible: boolean;
  /** Runs uploaded and not rejected. */
  uploaded: number;
  required: number;
  /** How many more are needed. Zero once eligible. */
  missing: number;
}

export function queueEligibility(
  uploaded: number,
  required: number = MIN_RUNS_TO_QUEUE,
): QueueEligibility {
  // A negative or nonsense count is treated as zero rather than trusted: this decides
  // whether somebody may play, so it should fail towards asking for more history.
  const safe = Number.isFinite(uploaded) && uploaded > 0 ? Math.floor(uploaded) : 0;

  return {
    eligible: safe >= required,
    uploaded: safe,
    required,
    missing: Math.max(0, required - safe),
  };
}

/** The refusal, worded for a person rather than a log. */
export function eligibilityMessage(state: QueueEligibility): string {
  return (
    `Play ${state.missing} more ${state.missing === 1 ? "run" : "runs"} before queueing. ` +
    `Ranked needs ${state.required} uploaded runs behind an account and you have ` +
    `${state.uploaded.toLocaleString()}.`
  );
}
