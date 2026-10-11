/**
 * How a ranked result moves a rating: the second version.
 *
 * glicko2.ts is the algorithm and stays exactly Glickman's. This is the policy wrapped
 * around it. Three changes to the first version's policy (settle-match, forfeitMatch)
 * were tried, and `npm run compare:ladders` measured each on a simulated async ladder in
 * four worlds - log loss on every rated match, predicted from the ratings at the time:
 *
 *                              as assumed  fast improvers  tight field  skill wanders
 *   first version                  0.6598      0.6639        0.6808        0.6670
 *   rounds as games                0.6532      0.6548        0.6780        0.6623
 *   + rated as they played         0.6518      0.6549        0.6765        0.6593
 *   + idle time instead            0.6544      0.6534        0.6785        0.6628
 *
 * ADOPTED: ROUNDS AS GAMES. A 3-0 and a 2-1 were the same win. The rounds are three
 * separate contests on three scenarios and close to independent (a player's consecutive
 * residuals correlate at 0.06 in the corpus), so reading the match as one coin flip
 * threw two thirds of what it said away. Better than the first version on all twelve
 * world-and-seed pairs.
 *
 * ADOPTED: RATED AS THEY PLAYED. An async opponent is a performance frozen when it was
 * played, and it was rated as its owner's rating today. The rating the rounds were played
 * at is what they measure. On top of rounds, better on 9 of 12 world-and-seed pairs; the
 * one world it does not win on average it loses by 0.0002. Together the two beat the first
 * version on all twelve. It also closes something no simulation scores: an owner can no
 * longer relabel rounds they have already banked by moving their current rating, up to
 * make them pay out or down to make them cost.
 *
 * REJECTED: IDLE TIME. Glicko-2 grows a player's deviation for every period they sit out,
 * and the ladder never ran that step. Running it, at the default volatility and a day per
 * period, was better on 6 of 12 world-and-seed pairs - a coin flip - and worse on average
 * in three of the four worlds, including the one where skill changes while a player is
 * away, which is the case it exists for. It stays here so
 * compare:ladders can measure it again, and nothing in settlement calls it.
 *
 * Pure, and shared by the Edge Functions and the simulator, so what is measured is what
 * runs.
 */

import { defaultRating, updateRating, winProbability, type GameResult, type Rating } from "./glicko2.ts";

/** Length of one Glicko-2 rating period for inflateForIdle: a day, as PLAN.md §4 names it. */
export const RATING_PERIOD_DAYS = 1;

/** No player is ever less certain than a blank account. */
export const MAX_RD = defaultRating().rd;

const DAY_MS = 86_400_000;

/**
 * Grow a rating's deviation for the periods it sat unused, exactly as Glicko-2's own
 * "did not compete" step does: φ' = √(φ² + n·σ²).
 *
 * Measured and not adopted (see the top of this file). At the default volatility it takes
 * a settled RD of 50 to about 76 after a month off and about 148 after six.
 */
export function inflateForIdle(r: Rating, lastRatedAt: Date | null, now: Date): Rating {
  if (!lastRatedAt) return r;
  const days = (now.getTime() - lastRatedAt.getTime()) / DAY_MS;
  const periods = days / RATING_PERIOD_DAYS;
  if (!(periods > 0)) return r;

  const SCALE = 173.7178;
  const phi = r.rd / SCALE;
  const grown = Math.sqrt(phi * phi + periods * r.volatility * r.volatility) * SCALE;
  return { ...r, rd: Math.min(MAX_RD, Math.max(r.rd, grown)) };
}

/** One frozen round's owner as they stood when it was played. */
export interface RoundStrength {
  /** `rating_before` of the side the round was played in. */
  rating: number | null;
  rd: number | null;
}

/**
 * The strength an async opponent's rounds represent: their rating when they played them.
 *
 * A match can draw its three rounds from three sittings, each with its own rating, so the
 * three are averaged, and the deviation is the root mean square of theirs - wider than
 * any one of them when the sittings disagree is not modelled, because they are the same
 * person days apart and the spread between them is already inside each RD.
 *
 * Falls back to the owner's current rating for a round whose side recorded none, which
 * only sides written before ratings were stored can lack.
 */
export function performanceRating(rounds: RoundStrength[], current: Rating): Rating {
  const known = rounds.filter((r) => r.rating !== null && Number.isFinite(r.rating));
  if (known.length === 0) return current;

  const rating = known.reduce((sum, r) => sum + (r.rating as number), 0) / known.length;
  const rd = Math.sqrt(
    known.reduce((sum, r) => {
      const d = r.rd !== null && Number.isFinite(r.rd) ? (r.rd as number) : current.rd;
      return sum + d * d;
    }, 0) / known.length,
  );
  return { rating, rd: Math.min(MAX_RD, rd), volatility: current.volatility };
}

/**
 * What a match tells the rating.
 *
 *   match    one game, won, lost or drawn. What the first version did.
 *   rounds   each counted round is its own game against the same opponent, applied
 *            together as one rating period, which is how Glicko-2 is defined over
 *            several results at once.
 *
 * `compare:ladders` decides between them; RANKED_OUTCOME is the one it chose.
 */
export type OutcomeModel = "match" | "rounds";

/** Adopted by compare:ladders: see the top of this file. */
export const RANKED_OUTCOME: OutcomeModel = "rounds";

export interface RoundTally {
  won: number;
  lost: number;
  tied: number;
}

/** The Glicko-2 games a result stands for, from the rated player's side. */
export function outcomeGames(tally: RoundTally, opponent: Rating, model: OutcomeModel): GameResult[] {
  const counted = tally.won + tally.lost + tally.tied;
  if (counted === 0) return [];

  if (model === "match") {
    const score = tally.won > tally.lost ? 1 : tally.won < tally.lost ? 0 : 0.5;
    return [{ opponent, score }];
  }

  return [
    ...Array.from({ length: tally.won }, () => ({ opponent, score: 1 })),
    ...Array.from({ length: tally.lost }, () => ({ opponent, score: 0 })),
    ...Array.from({ length: tally.tied }, () => ({ opponent, score: 0.5 })),
  ];
}

export interface RankedUpdate {
  before: Rating;
  after: Rating;
  /** The Glicko-2 score recorded on the rating receipt: share of the games won. */
  score: number;
}

/**
 * Rate one result.
 *
 * `weight` damps the change the way settle-match always has: it scales the movement away
 * from `before`, and zero leaves the rating where it was.
 */
export function rateResult(input: {
  before: Rating;
  opponent: Rating;
  tally: RoundTally;
  weight?: number;
  model?: OutcomeModel;
}): RankedUpdate {
  const model = input.model ?? RANKED_OUTCOME;
  const weight = Math.min(1, Math.max(0, input.weight ?? 1));
  const before = input.before;
  const games = outcomeGames(input.tally, input.opponent, model);

  if (games.length === 0) return { before, after: before, score: 0.5 };

  const raw = updateRating(before, games);
  const after: Rating = {
    rating: before.rating + (raw.rating - before.rating) * weight,
    rd: before.rd + (raw.rd - before.rd) * weight,
    volatility: raw.volatility,
  };
  const score = games.reduce((sum, g) => sum + g.score, 0) / games.length;
  return { before, after, score };
}

/**
 * Rate a forfeit: every round lost.
 *
 * Leaving and running out the clock cost the same as being beaten on every scenario, so
 * neither is ever cheaper than playing the match out and losing it.
 */
export function rateForfeit(input: {
  before: Rating;
  opponent: Rating;
  rounds: number;
  model?: OutcomeModel;
}): RankedUpdate {
  return rateResult({ ...input, tally: { won: 0, lost: input.rounds, tied: 0 } });
}

/**
 * Probability of winning the match, under the outcome model's own reading of a rating.
 *
 * Under `rounds` a rating gap is a per-round probability, and a match is won by taking
 * more of three rounds than the other side; under `match` the gap is the match directly.
 * Ties are not modelled, because on raw scores they effectively do not happen.
 */
export function matchWinProbability(player: Rating, opponent: Rating, model: OutcomeModel = RANKED_OUTCOME, rounds = 3): number {
  const p = winProbability(player, opponent);
  if (model === "match") return p;
  let win = 0;
  const need = Math.floor(rounds / 2) + 1;
  for (let k = need; k <= rounds; k++) win += binomial(rounds, k) * p ** k * (1 - p) ** (rounds - k);
  return win;
}

function binomial(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - i + 1)) / i;
  return out;
}

/**
 * What every possible result would do to the rating, so the match screen can say what is
 * at stake before anybody plays.
 *
 * Computed by the server from the same function settlement uses, so the number shown is
 * the number applied unless the player's rating moves in between (another match settling
 * first), and the client never works it out for itself.
 */
export function stakes(input: {
  before: Rating;
  opponent: Rating;
  rounds?: number;
  model?: OutcomeModel;
}): { result: string; change: number }[] {
  const rounds = input.rounds ?? 3;
  const out: { result: string; change: number }[] = [];
  for (let won = rounds; won >= 0; won--) {
    const lost = rounds - won;
    const r = rateResult({ ...input, tally: { won, lost, tied: 0 } });
    out.push({ result: `${won}-${lost}`, change: Math.round(r.after.rating - r.before.rating) });
  }
  return out;
}
