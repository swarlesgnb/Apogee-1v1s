/**
 * Settle a match.
 *
 * Two formats, and the ranked ladder uses the first.
 *
 * **Rounds (ranked, duels, tournaments, the demo match).** Both sides play the same
 * three scenarios, one attempt each. Each scenario is a round, won by the higher raw
 * score; the side that wins more rounds wins the match. Equal rounds won is a draw.
 *
 * **Mean delta (ghost matches).** Each scenario is scored as a delta against the
 * player's own baseline, the deltas are averaged, and the higher average wins.
 *
 *     delta_i     = (score_i - baseline_i) / baseline_i
 *     matchScore  = mean(delta_1, delta_2, delta_3)
 *
 * Ranked used to be mean delta, on the theory that normalising against each player's own
 * baseline lets any two players have a real contest. Real play showed what it costs: a
 * player's baseline catches up with them, so after a first win a second needed something
 * close to a PB, and because the delta does not depend on how good anybody is, rating
 * stopped tracking skill and improving stopped being rewarded. Raw rounds with Glicko
 * matchmaking give an even contest the ordinary way, by pairing people of similar
 * strength (PLAN.md §3).
 *
 * Deltas are still computed and stored in both formats. In rounds they are the
 * "against your usual" line on the result screen and decide nothing.
 */

import type { VerificationTier } from "../verify/verifyRun.ts";

export interface RoundSubmission {
  scenarioId: number;
  scenarioName: string;
  score: number;
  /** The player's baseline for this scenario at the time of play. */
  baseline: number;
  /** True when the baseline came from a fallback rather than real history. */
  provisional: boolean;
  verificationTier: VerificationTier;
  /**
   * True when the player left before the scenario finished: a crash, an alt-F4, or a
   * quit. Derived from the run's own length against the scenario's known one
   * (`isAbandonedRun`), never from anything the player could edit.
   */
  abandoned?: boolean;
}

export interface RoundOutcome extends RoundSubmission {
  /** Signed fraction above or below baseline. Null when no baseline was usable. */
  delta: number | null;
  counted: boolean;
  excludedReason?: string;
}

export interface SideOutcome {
  rounds: RoundOutcome[];
  /** Mean of the counted deltas. Null when nothing counted. */
  matchScore: number | null;
  countedRounds: number;
  /** True when any counted round leaned on a provisional baseline. */
  provisional: boolean;
}

export type MatchVerdict = "win" | "loss" | "draw" | "void";

export type MatchFormat = "rounds" | "mean-delta";

export interface SettlementInput {
  playerRounds: RoundSubmission[];
  opponentRounds: RoundSubmission[];
  /** Defaults to mean delta, which is what ghost matches were measured against. */
  format?: MatchFormat;
}

/** One round of a rounds-format match, from the player's side. */
export type RoundResult = "won" | "lost" | "tied";

export interface Settlement {
  player: SideOutcome;
  opponent: SideOutcome;
  verdict: MatchVerdict;
  format: MatchFormat;
  /** Per counted round in scenario order, rounds format only. Null on a void. */
  roundResults: RoundResult[] | null;
  /** Why the match was voided, when it was. */
  voidReason?: string;
  /**
   * Weight to apply to the rating update, 0..1. Zero on a void. In mean delta, reduced
   * when either side relied on provisional baselines, so a placement-quality match cannot
   * swing a settled rating; in rounds a baseline decides nothing, so it is never reduced.
   */
  ratingWeight: number;
}

/** Deltas closer than this are a draw rather than a win by noise. */
const DRAW_EPSILON = 0.0005;

/** Rating weight when either side used a fallback baseline. */
const PROVISIONAL_WEIGHT = 0.5;

export function computeDelta(score: number, baseline: number): number | null {
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  if (!Number.isFinite(score)) return null;
  return (score - baseline) / baseline;
}

/**
 * Score one side on its own.
 *
 * Exported for the seeding match a player gets when the pool is empty: there is no
 * opponent to compare against, but the side's deltas still have to be computed and
 * stored, because that stored run set is exactly what the next player is matched
 * against.
 */
export function settleSide(rounds: RoundSubmission[], format: MatchFormat = "mean-delta"): SideOutcome {
  const outcomes: RoundOutcome[] = rounds.map((round) => {
    if (round.verificationTier === "rejected") {
      return {
        ...round,
        delta: null,
        counted: false,
        excludedReason: "run failed verification",
      };
    }

    // A run that stopped early is not a bad performance, it is an absent one. Scoring
    // it would let a crash on the one attempt that counts (PLAN.md §3) settle as a
    // loss. Excluding it instead leaves this side a round short, which the round-count
    // guard in settleMatch turns into a void at zero rating weight: no loss, no win.
    if (round.abandoned) {
      return {
        ...round,
        delta: null,
        counted: false,
        excludedReason: "left before the scenario finished",
      };
    }

    const delta = computeDelta(round.score, round.baseline);

    // In rounds the baseline decides nothing, so a missing one costs the round its
    // "against your usual" line and nothing else. Excluding it would void the match over
    // a number the result never reads.
    if (delta === null && format === "rounds") {
      return { ...round, delta: null, counted: true };
    }

    if (delta === null) {
      return {
        ...round,
        delta: null,
        counted: false,
        excludedReason: "no usable baseline",
      };
    }

    return { ...round, delta, counted: true };
  });

  const counted = outcomes.filter((r) => r.counted);
  const withDelta = counted.filter((r) => r.delta !== null);
  const matchScore =
    withDelta.length > 0
      ? withDelta.reduce((sum, r) => sum + (r.delta ?? 0), 0) / withDelta.length
      : null;

  return {
    rounds: outcomes,
    matchScore,
    countedRounds: counted.length,
    provisional: counted.some((r) => r.provisional),
  };
}

export function settleMatch(input: SettlementInput): Settlement {
  const format = input.format ?? "mean-delta";
  const player = settleSide(input.playerRounds, format);
  const opponent = settleSide(input.opponentRounds, format);
  const voided = (voidReason: string): Settlement => ({
    player, opponent, verdict: "void", format, roundResults: null, voidReason, ratingWeight: 0,
  });

  // A match is only meaningful if both sides completed the same rounds. Anything else
  // is voided rather than guessed at, since a partial match that still moved rating would
  // be a straightforward way to farm a favourable result.
  if (player.countedRounds === 0 || opponent.countedRounds === 0) {
    return voided("one side has no countable rounds");
  }

  if (player.countedRounds !== opponent.countedRounds) {
    // Name abandonment for what it is. This string is shown to the player, and "you
    // completed 2 rounds and they completed 3" reads like the app lost track of
    // something, which is the impression a void must not leave.
    const abandonedRounds = [...player.rounds, ...opponent.rounds].filter(
      (r) => r.abandoned,
    );

    return voided(
      abandonedRounds.length > 0
        ? `a scenario was left before it finished (${abandonedRounds
            .map((r) => r.scenarioName)
            .join(", ")})`
        : `sides completed different numbers of rounds ` +
          `(${player.countedRounds} vs ${opponent.countedRounds})`,
    );
  }

  if (format === "rounds") {
    // Equal counts are not enough here, because rounds are compared pairwise: one side
    // missing round 1 and the other round 2 would compare a scenario against nothing.
    // Mean delta never noticed, since an average does not care which rounds it averages.
    const misaligned = player.rounds.some((r, i) => r.counted !== opponent.rounds[i]?.counted);
    if (misaligned) return voided("the sides counted different scenarios");

    // Raw score against raw score on the same scenario, so nothing needs normalising.
    const roundResults: RoundResult[] = [];
    for (const [i, mine] of player.rounds.entries()) {
      if (!mine.counted) continue;
      const theirs = opponent.rounds[i].score;
      roundResults.push(mine.score > theirs ? "won" : mine.score < theirs ? "lost" : "tied");
    }

    const won = roundResults.filter((r) => r === "won").length;
    const lost = roundResults.filter((r) => r === "lost").length;
    const verdict: MatchVerdict = won > lost ? "win" : won < lost ? "loss" : "draw";

    return { player, opponent, verdict, format, roundResults, ratingWeight: 1 };
  }

  const a = player.matchScore ?? 0;
  const b = opponent.matchScore ?? 0;
  const gap = a - b;

  const verdict: MatchVerdict =
    Math.abs(gap) < DRAW_EPSILON ? "draw" : gap > 0 ? "win" : "loss";

  const ratingWeight =
    player.provisional || opponent.provisional ? PROVISIONAL_WEIGHT : 1;

  return { player, opponent, verdict, format, roundResults: null, ratingWeight };
}

/** Rounds won, lost and tied, from the player's side. All zero outside rounds format. */
export function roundTally(settlement: Settlement): { won: number; lost: number; tied: number } {
  const results = settlement.roundResults ?? [];
  return {
    won: results.filter((r) => r === "won").length,
    lost: results.filter((r) => r === "lost").length,
    tied: results.filter((r) => r === "tied").length,
  };
}

/** Glicko-2 score for a verdict, from the player's perspective. */
export function verdictToScore(verdict: MatchVerdict): number {
  if (verdict === "win") return 1;
  if (verdict === "loss") return 0;
  return 0.5;
}

/**
 * A one-line explanation of the result, in the player's own terms.
 *
 * Exists because "you scored more and lost" is a real and legitimate outcome of the mean
 * delta format, and it has to be explained the moment it happens rather than discovered.
 * In rounds the tally is the whole explanation.
 */
export function explainVerdict(settlement: Settlement): string {
  if (settlement.verdict === "void") {
    return `Match void: ${settlement.voidReason ?? "incomplete"}.`;
  }

  if (settlement.format === "rounds") {
    const { won, lost, tied } = roundTally(settlement);
    const score = `${won}–${lost}${tied > 0 ? `, ${tied} tied` : ""}`;
    if (settlement.verdict === "draw") return `Draw, ${score} on rounds.`;
    return `You ${settlement.verdict === "win" ? "win" : "lose"} ${score} on rounds.`;
  }

  const you = settlement.player.matchScore ?? 0;
  const them = settlement.opponent.matchScore ?? 0;
  const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;

  const rawYou = settlement.player.rounds
    .filter((r) => r.counted)
    .reduce((sum, r) => sum + r.score, 0);
  const rawThem = settlement.opponent.rounds
    .filter((r) => r.counted)
    .reduce((sum, r) => sum + r.score, 0);

  const outscored = rawYou > rawThem;
  const lost = settlement.verdict === "loss";

  const headline =
    settlement.verdict === "draw"
      ? `Draw, both ${pct(you)} against your baselines.`
      : `You ${settlement.verdict === "win" ? "win" : "lose"}: ` +
        `${pct(you)} vs ${pct(them)} against your own baselines.`;

  // The specific case that reads as a bug unless it is named.
  if (lost && outscored) {
    return (
      `${headline} You scored more raw points, but they beat their own baseline by more, ` +
      `and that is what decides a round.`
    );
  }

  return headline;
}
