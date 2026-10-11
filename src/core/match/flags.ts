/**
 * Flags: a seeding run set planted as an open challenge.
 *
 * WHAT A FLAG IS
 *
 * When the pool is empty, a ranked match is played against a Shadow (shadow.ts) and the
 * player's three runs are stored the way a seeding side always was: they become an
 * opponent the next player can be matched against. A Flag is that stored side with one
 * promise attached. The first real player who answers it within FLAG_TTL_MS settles a
 * rated match for both of them, and the player who planted it is told the next time the
 * app opens.
 *
 * It is a duel addressed to the pool rather than to a person. That is the whole design
 * and the reason it is safe: everything a duel's challenger can do with their seeding
 * match, a planter can do with theirs, and nothing more.
 *
 * WHY THE PLANTER IS RATED ONCE, AND NOT ON EVERY ANSWER
 *
 * A stored side is never consumed; it answers as many players as draw it. Rating its owner
 * on every answer would turn one afternoon into ten rating changes (prepareChallengerRating
 * says the same about the pool). So the rule, which is the farm bound this feature is held
 * to, is that every run set rates its owner at most once:
 *
 *   contested side   rated when played (unchanged)
 *   duel challenger  rated when the duel is answered (unchanged)
 *   flag planter     rated when the flag is first answered, within its window
 *
 * After that, or after it expires, the run set stays in the pool and rates only whoever
 * answers it, exactly as every seeding side did before Flags existed.
 *
 * WHAT DOES NOT ANSWER A FLAG
 *
 *   a void          an abandoned round or a rejected run voids the answer match, and a
 *                   result nobody played to the end is not a contest
 *   a forfeit       the answerer leaving would otherwise hand the planter a free win, and
 *                   a second account could hand it over on purpose
 *   a late draw     an answer match created after the flag expired
 *
 * Each leaves the flag open for the next player.
 */

/**
 * How long a flag waits for an answer.
 *
 * Seven days, the duel's number and for the duel's reason (duels.ts): a match deadline is how
 * long somebody has to play, and this is how long somebody has to turn up. A week of
 * evenings is the unit somebody who plays after work has.
 */
export const FLAG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FLAG_TTL_DAYS = Math.round(FLAG_TTL_MS / 86_400_000);

export type FlagStatus = "open" | "answered" | "expired";

export interface Flag {
  id: string;
  planterId: string;
  status: FlagStatus;
  plantedAt: Date;
  expiresAt: Date;
  answerMatchId?: string | null;
}

/** What the planter's seeding match has to be for its run set to become a flag. */
export interface PlantingFacts {
  /** False for a tournament leg. */
  rated: boolean;
  /** Rounds that counted, against rounds in the match. */
  countedRounds: number;
  rounds: number;
  /** The match was a Shadow match from the queue, not a duel's or a fixture's first leg. */
  shadow: boolean;
}

/**
 * Only a complete, rated, queue-born seeding side is planted.
 *
 * A duel's seeding side already has its one rating (the duel), and a tournament leg is
 * unrated by agreement. A side with an uncounted round never reaches the pool at all.
 */
export function shouldPlant(f: PlantingFacts): boolean {
  return f.rated && f.shadow && f.rounds > 0 && f.countedRounds === f.rounds;
}

/** A flag's status as of `now`: open past its deadline reads as expired. */
export function flagStatus(flag: Pick<Flag, "status" | "expiresAt">, now: Date): FlagStatus {
  if (flag.status === "open" && now.getTime() >= flag.expiresAt.getTime()) return "expired";
  return flag.status;
}

export type AnswerOutcome = "win" | "loss" | "draw" | "void" | "forfeit";

export interface AnswerFacts {
  answererId: string;
  /** When the answer match was created: what has to fall inside the flag's window. */
  answerCreatedAt: Date;
  outcome: AnswerOutcome;
  /** False for a tournament leg, which never draws from the pool anyway. */
  rated: boolean;
}

/** Whether an answer settles a flag, and if not, why not. */
export function canSettle(flag: Flag, a: AnswerFacts): { ok: true } | { ok: false; reason: string } {
  if (flag.status !== "open") return { ok: false, reason: "the flag has already been answered" };
  if (a.answerCreatedAt.getTime() >= flag.expiresAt.getTime()) return { ok: false, reason: "the flag had expired" };
  if (a.answererId === flag.planterId) return { ok: false, reason: "a player cannot answer their own flag" };
  if (!a.rated) return { ok: false, reason: "unrated matches do not answer flags" };
  if (a.outcome === "void") return { ok: false, reason: "a void answer is not a contest" };
  if (a.outcome === "forfeit") return { ok: false, reason: "a forfeit does not settle a flag" };
  return { ok: true };
}

/** The flag after an answer: settled once, never again. */
export function applyAnswer(flag: Flag, a: AnswerFacts, answerMatchId: string): Flag {
  return canSettle(flag, a).ok ? { ...flag, status: "answered", answerMatchId } : flag;
}

/** The planter's verdict is the answerer's, mirrored. */
export function planterVerdict(answerer: "win" | "loss" | "draw"): "win" | "loss" | "draw" {
  return answerer === "win" ? "loss" : answerer === "loss" ? "win" : "draw";
}

interface RatingLike {
  rating: number;
  rd: number;
  volatility: number;
}

/**
 * The planter's rating change for a settled answer.
 *
 * The same damped Glicko-2 step a duel's challenger takes (prepareChallengerRating), against
 * the answerer's rating as it stood when they played, at the match's own weight: halved when
 * either side leaned on a provisional baseline, so a placement-quality result cannot swing a
 * settled rating. Shared by settle-match and the validator so the two cannot drift.
 */
export function planterRating(
  planter: RatingLike,
  answerer: { rating: number; rd: number },
  verdict: "win" | "loss" | "draw",
  weight: number,
  updateRating: (p: RatingLike, games: { opponent: RatingLike; score: number }[]) => RatingLike,
): { after: RatingLike; score: number } {
  const score = verdict === "win" ? 1 : verdict === "loss" ? 0 : 0.5;
  const raw = updateRating(planter, [{ opponent: { rating: answerer.rating, rd: answerer.rd, volatility: 0.06 }, score }]);
  return {
    score,
    after: {
      rating: planter.rating + (raw.rating - planter.rating) * weight,
      rd: planter.rd + (raw.rd - planter.rd) * weight,
      volatility: raw.volatility,
    },
  };
}

// ---------------------------------------------------------------------------
// words, shared by the server's messages and the client's panel
// ---------------------------------------------------------------------------

export function daysLeft(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000));
}

/** "Flag planted: Intermediate band, Precise Tracking. It settles when someone answers it (up to 7 days)." */
export function plantedLine(band: string, category: string, ttlDays = FLAG_TTL_DAYS): string {
  return `Flag planted: ${band} band, ${category}. It settles when someone answers it (up to ${ttlDays} days).`;
}

/** Said before the player commits, when the pool has nobody for them. */
export function shadowQueueLine(shadowLabel: string): string {
  return `No one in your band right now. You'll face a Shadow now (${shadowLabel}), and your run set stays planted as a Flag.`;
}

export function answeredLine(o: {
  category: string;
  by: string;
  verdict: "win" | "loss" | "draw";
  ratingChange: number | null;
}): string {
  const result = o.verdict === "win" ? "you won" : o.verdict === "loss" ? "they won" : "it was a draw";
  const move = o.ratingChange == null ? "" : `, ${o.ratingChange >= 0 ? "+" : "−"}${Math.abs(o.ratingChange)} rating`;
  return `Your ${o.category} Flag was answered by ${o.by}: ${result}${move}.`;
}

export function expiredLine(category: string): string {
  return `Your ${category} Flag expired unanswered. Its run set stays in the pool; it no longer rates you.`;
}
