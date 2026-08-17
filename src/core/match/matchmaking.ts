/**
 * Async matchmaking.
 *
 * A synchronous 1v1 queue with five users is an empty queue, and an empty queue kills
 * the app in week one (PLAN.md §6). So a player is matched against a *stored* run set
 * from someone near their rating: their opponent's deltas were computed and frozen when
 * they played, and the result settles the moment the live player finishes.
 *
 * This works with one player online, and every match played deepens the pool for
 * everyone else. Live mode reuses all of this and adds only a queue and a countdown.
 */

import { winProbability, type Rating } from "../rating/glicko2.ts";

/** A completed set of rounds someone left behind, available as an opponent. */
export interface StoredRunSet {
  id: string;
  playerId: string;
  displayName: string;
  category: string;
  difficulty: string;
  scenarioIds: number[];
  /** Frozen at play time, in scenarioIds order. */
  deltas: number[];
  matchScore: number;
  rating: Rating;
  createdAt: Date;
  /** True when it leaned on fallback baselines. */
  provisional: boolean;
}

export interface MatchmakingCriteria {
  playerId: string;
  rating: Rating;
  category: string;
  difficulty: string;
  now?: Date;
  /** Opponents this player has already faced recently, to avoid repeats. */
  recentOpponentIds?: Set<string>;
}

export interface Candidate {
  runSet: StoredRunSet;
  score: number;
  winProbability: number;
  reasons: string[];
}

/** Ideal opponent: an even contest. Distance from 0.5 is the primary cost. */
const FAIRNESS_WEIGHT = 100;

/** Staler run sets are less appealing, but never disqualified. */
const AGE_WEIGHT = 8;
const AGE_HALF_LIFE_DAYS = 14;

/** Facing the same person repeatedly makes the ladder feel small. */
const REPEAT_PENALTY = 25;

/** Provisional opponents make for a noisier result. */
const PROVISIONAL_PENALTY = 10;

function ageDays(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Score a candidate opponent. Lower is better.
 *
 * Fairness dominates deliberately: a lopsided match teaches the rating system little
 * and feels pointless to both sides.
 */
export function scoreCandidate(
  criteria: MatchmakingCriteria,
  runSet: StoredRunSet,
): Candidate {
  const now = criteria.now ?? new Date();
  const reasons: string[] = [];

  const p = winProbability(criteria.rating, runSet.rating);
  const fairness = Math.abs(p - 0.5) * FAIRNESS_WEIGHT;
  let score = fairness;

  if (fairness > 20) reasons.push("rating gap is wide");

  // Exponential decay, so a two-week-old set costs one unit and a very old one is
  // discouraged without ever being unusable.
  const age = ageDays(runSet.createdAt, now);
  const agePenalty = AGE_WEIGHT * (1 - Math.pow(0.5, age / AGE_HALF_LIFE_DAYS));
  score += agePenalty;
  if (age > 30) reasons.push("run set is over a month old");

  if (criteria.recentOpponentIds?.has(runSet.playerId)) {
    score += REPEAT_PENALTY;
    reasons.push("faced recently");
  }

  if (runSet.provisional) {
    score += PROVISIONAL_PENALTY;
    reasons.push("opponent's baselines were provisional");
  }

  return { runSet, score, winProbability: p, reasons };
}

export interface MatchmakingResult {
  opponent: StoredRunSet | null;
  candidate: Candidate | null;
  considered: number;
  rejected: { reason: string; count: number }[];
}

/**
 * Find the best available opponent.
 *
 * Returns null rather than a bad match when nothing suitable exists, because offering an
 * absurd opponent is worse than telling the player to try a different category.
 */
export function findOpponent(
  criteria: MatchmakingCriteria,
  pool: StoredRunSet[],
): MatchmakingResult {
  const rejections = new Map<string, number>();
  const reject = (reason: string) => {
    rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
  };

  const eligible = pool.filter((runSet) => {
    // Never match a player against their own stored run.
    if (runSet.playerId === criteria.playerId) {
      reject("own run set");
      return false;
    }
    if (runSet.category !== criteria.category) {
      reject("different category");
      return false;
    }
    if (runSet.difficulty !== criteria.difficulty) {
      reject("different difficulty");
      return false;
    }
    if (runSet.deltas.length === 0) {
      reject("no deltas recorded");
      return false;
    }
    return true;
  });

  const rejected = [...rejections].map(([reason, count]) => ({ reason, count }));

  if (eligible.length === 0) {
    return { opponent: null, candidate: null, considered: pool.length, rejected };
  }

  const scored = eligible
    .map((runSet) => scoreCandidate(criteria, runSet))
    .sort((a, b) => a.score - b.score);

  return {
    opponent: scored[0].runSet,
    candidate: scored[0],
    considered: pool.length,
    rejected,
  };
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
