/**
 * Async matchmaking.
 *
 * A synchronous 1v1 queue with five users is an empty queue, and an empty queue kills
 * the app in week one (PLAN.md §6). So a player is matched against *stored* rounds from
 * someone near their rating: each round was one attempt the opponent played in an
 * earlier match, frozen when they played it, and the result settles the moment the live
 * player finishes.
 *
 * The opponent is a player's bank of rounds, not one stored match.
 *
 * It used to be one stored match: the caller played the opponent's exact three
 * scenarios, and the caller's own finished side then went into the pool carrying those
 * same three. Every match answered from the pool cloned its scenario set into another
 * candidate, so a category's first seeding match decided what nearly everyone in that
 * category played from then on, and a fresh set only appeared when nobody at all was
 * available. In the first week of real play that meant the same three scenarios, queue
 * after queue, out of a window that holds far more. Rounds are independent - each is one scenario, one attempt, one comparison -
 * so the three can come from three different sittings of the same opponent, and the set
 * is drawn fresh for every match from whatever that opponent has played.
 */

import { winProbability, type Rating } from "../rating/glicko2.ts";
import { matchesCategory, selectScenarios, type SelectableScenario } from "./scenarioSelection.ts";

/**
 * The category that means "whatever you have".
 *
 * The client's own word for it, and the value stored on a match created from that
 * queue, so this is the one place that has to know the string.
 */
export const ANY_CATEGORY = "Any";

/** Rounds in a match. */
export const ROUNDS_PER_MATCH = 3;

/**
 * How many of the caller's own most recent matches count as "played recently".
 *
 * Three matches is nine scenarios, a little over half of a skill window (about
 * seventeen) - enough that back-to-back queues do not hand out the same scenarios, not
 * so many that a sub-skill window of six is permanently stale.
 */
export const RECENT_MATCHES_FOR_VARIETY = 3;

/**
 * Fewest scenarios in an offer that must be fresh before a seeding match is preferred.
 *
 * Below this, the only opponents available can do little but replay what the caller
 * just played, and a seeding match drawn away from it is how scenarios nobody has
 * played yet get into anybody's bank at all.
 */
export const MIN_FRESH_SCENARIOS = 2;

/** One attempt from an earlier match, available to be played against. */
export interface BankRound {
  /** `runs.id`. Null only for a side stored before run ids were recorded. */
  runId: string | null;
  scenarioId: number;
  /** Frozen at play time. */
  delta: number;
  /** True when its baseline was a fallback. */
  provisional: boolean;
  /** The window it was played in. */
  difficulty: string;
  playedAt: Date;
  /** The stored side it came from (`runSetId`), for history recorded before run ids. */
  sideId: string;
}

/** Everything one opponent has left behind that could answer a match. */
export interface OpponentBank {
  playerId: string;
  displayName: string;
  rating: Rating;
  rounds: BankRound[];
}

export interface MatchmakingCriteria {
  playerId: string;
  rating: Rating;
  category: string;
  difficulty: string;
  /** The window's scenarios. A round on a scenario outside it is never offered. */
  pool: SelectableScenario[];
  /** Drives which of an opponent's scenarios are drawn, so the draw is reproducible. */
  seed: string;
  now?: Date;
  /** Opponents this player has already faced recently, to avoid repeats. */
  recentOpponentIds?: Set<string>;
  /** Scenario ids from the caller's last few matches, drawn last and costed. */
  playedRecently?: Set<number>;
  /**
   * Runs this player has already played against, by `runs.id`.
   *
   * Excluded rather than penalised. `recentOpponentIds` is the right shape for "you two
   * have met lately" and costs 25; this is a different thing entirely, because the same
   * run is the same attempt with the same frozen delta. That is not a worse pairing, it
   * is a round whose answer is already known - and on a thin pool a penalty gets paid
   * gladly, because there is nothing else to spend it on.
   */
  facedRunIds?: Set<string>;
  /**
   * Stored sides already played against, by `runSetId`. The same exclusion for matches
   * whose copied side was written before copies recorded their run ids.
   */
  facedSideIds?: Set<string>;
}

export interface Candidate {
  bank: OpponentBank;
  /** The rounds this opponent would play, one per scenario, in match order. */
  rounds: BankRound[];
  /** How many of those scenarios are outside `playedRecently`. */
  fresh: number;
  score: number;
  winProbability: number;
  reasons: string[];
}

/** Ideal opponent: an even contest. Distance from 0.5 is the primary cost. */
const FAIRNESS_WEIGHT = 100;

/** Staler rounds are less appealing, but never disqualified. */
const AGE_WEIGHT = 8;
const AGE_HALF_LIFE_DAYS = 14;

/** Facing the same person repeatedly makes the ladder feel small. */
const REPEAT_PENALTY = 25;

/** Provisional opponents make for a noisier result. */
const PROVISIONAL_PENALTY = 10;

/**
 * Each scenario the caller played in their last few matches.
 *
 * Below fairness on purpose: a stale scenario against an even opponent is a better match
 * than three fresh ones against somebody 300 points away. Three stale scenarios cost 30,
 * which is what a win probability of 0.8 instead of 0.5 costs.
 */
const STALE_SCENARIO_PENALTY = 10;

function ageDays(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * What one opponent can offer this caller: their most recent unfaced round on each
 * scenario in the queued category and window.
 *
 * Most recent rather than best or median, because each round was one attempt that
 * counted when it was played, the same single attempt the caller is about to make.
 */
export function offerableRounds(criteria: MatchmakingCriteria, bank: OpponentBank): Map<number, BankRound> {
  const inCategory = new Set(
    criteria.pool.filter((s) => matchesCategory(s, criteria.category)).map((s) => s.id),
  );

  const latest = new Map<number, BankRound>();
  for (const round of bank.rounds) {
    if (round.difficulty !== criteria.difficulty) continue;
    if (!inCategory.has(round.scenarioId)) continue;
    if (!Number.isFinite(round.delta)) continue;
    if (round.runId && criteria.facedRunIds?.has(round.runId)) continue;
    if (criteria.facedSideIds?.has(round.sideId)) continue;

    const held = latest.get(round.scenarioId);
    if (!held || round.playedAt.getTime() > held.playedAt.getTime()) {
      latest.set(round.scenarioId, round);
    }
  }
  return latest;
}

/**
 * Which three of an opponent's scenarios this match would be played on.
 *
 * The seeded draw `selectScenarios` already makes for a seeding match, run over the
 * scenarios this opponent can answer: fresh ones first, recently played ones only as
 * filler. Null when the opponent cannot answer three distinct scenarios.
 */
export function drawRounds(criteria: MatchmakingCriteria, offer: Map<number, BankRound>): BankRound[] | null {
  if (offer.size < ROUNDS_PER_MATCH) return null;

  const offered = criteria.pool.filter((s) => offer.has(s.id));
  const recentNames = new Set(
    criteria.pool.filter((s) => criteria.playedRecently?.has(s.id)).map((s) => s.name),
  );

  const drawn = selectScenarios(offered, criteria.seed, {
    category: criteria.category,
    playedRecently: recentNames,
    count: ROUNDS_PER_MATCH,
  });

  if (new Set(drawn.map((s) => s.id)).size < ROUNDS_PER_MATCH) return null;
  return drawn.map((s) => offer.get(s.id)!);
}

/**
 * Score a candidate opponent and the rounds they would play. Lower is better.
 *
 * Fairness dominates deliberately: a lopsided match teaches the rating system little
 * and feels pointless to both sides.
 */
export function scoreCandidate(
  criteria: MatchmakingCriteria,
  bank: OpponentBank,
  rounds: BankRound[],
): Candidate {
  const now = criteria.now ?? new Date();
  const reasons: string[] = [];

  const p = winProbability(criteria.rating, bank.rating);
  const fairness = Math.abs(p - 0.5) * FAIRNESS_WEIGHT;
  let score = fairness;

  if (fairness > 20) reasons.push("rating gap is wide");

  // Exponential decay on the rounds' mean age, so a two-week-old offer costs one unit
  // and a very old one is discouraged without ever being unusable.
  const age = rounds.reduce((sum, r) => sum + ageDays(r.playedAt, now), 0) / Math.max(1, rounds.length);
  const agePenalty = AGE_WEIGHT * (1 - Math.pow(0.5, age / AGE_HALF_LIFE_DAYS));
  score += agePenalty;
  if (age > 30) reasons.push("rounds are over a month old");

  if (criteria.recentOpponentIds?.has(bank.playerId)) {
    score += REPEAT_PENALTY;
    reasons.push("faced recently");
  }

  if (rounds.some((r) => r.provisional)) {
    score += PROVISIONAL_PENALTY;
    reasons.push("opponent's baselines were provisional");
  }

  const stale = rounds.filter((r) => criteria.playedRecently?.has(r.scenarioId)).length;
  if (stale > 0) {
    score += stale * STALE_SCENARIO_PENALTY;
    reasons.push(`${stale} scenario(s) played recently`);
  }

  return { bank, rounds, fresh: rounds.length - stale, score, winProbability: p, reasons };
}

export interface MatchmakingResult {
  opponent: OpponentBank | null;
  candidate: Candidate | null;
  considered: number;
  rejected: { reason: string; count: number }[];
}

/**
 * Find the best available opponent, and the three rounds they would play.
 *
 * Returns null rather than a bad match when nothing suitable exists, because offering an
 * absurd opponent is worse than telling the player to try a different category.
 */
export function findOpponent(
  criteria: MatchmakingCriteria,
  banks: OpponentBank[],
): MatchmakingResult {
  const rejections = new Map<string, number>();
  const reject = (reason: string) => {
    rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
  };

  const scored: Candidate[] = [];
  for (const bank of banks) {
    // Never match a player against their own stored rounds.
    if (bank.playerId === criteria.playerId) {
      reject("own rounds");
      continue;
    }

    // Category, difficulty and "already played against" all apply per round, so they
    // are folded into one question: can this opponent still answer three scenarios?
    // "Any" is a wildcard over categories and only over categories, which offerableRounds
    // gets from matchesCategory.
    const rounds = drawRounds(criteria, offerableRounds(criteria, bank));
    if (!rounds) {
      reject("fewer than three unplayed scenarios in this category and window");
      continue;
    }

    scored.push(scoreCandidate(criteria, bank, rounds));
  }

  const rejected = [...rejections].map(([reason, count]) => ({ reason, count }));

  if (scored.length === 0) {
    return { opponent: null, candidate: null, considered: banks.length, rejected };
  }

  scored.sort((a, b) => a.score - b.score);

  return {
    opponent: scored[0].bank,
    candidate: scored[0],
    considered: banks.length,
    rejected,
  };
}

/**
 * Should this queue get a seeding match even though an opponent was found?
 *
 * Only when the best opponent can offer little but what the caller just played, and the
 * window itself still has fresh scenarios to plant. Without the second condition a
 * player who has worked through a small sub-skill window would be handed unrated seeding
 * matches forever, which is a worse thing to be bored by than a repeat.
 */
export function shouldPlantFresh(criteria: MatchmakingCriteria, result: MatchmakingResult): boolean {
  if (!result.candidate) return false;
  if (result.candidate.fresh >= MIN_FRESH_SCENARIOS) return false;

  const freshInWindow = criteria.pool.filter(
    (s) => matchesCategory(s, criteria.category) && !criteria.playedRecently?.has(s.id),
  ).length;

  return freshInWindow >= ROUNDS_PER_MATCH;
}

/**
 * Should this player's completed rounds be added to the pool as a future opponent?
 *
 * Rejected runs and voided matches must never become someone else's opponent, or a
 * forged result would propagate through the ladder rather than being contained.
 */
export function isPoolWorthy(runSet: {
  deltas: number[];
  anyRejected: boolean;
}): boolean {
  return runSet.deltas.length > 0 && !runSet.anyRejected;
}
