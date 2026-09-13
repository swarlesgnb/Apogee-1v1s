/**
 * Settle a match.
 *
 * The format (PLAN.md §3): three scenarios from a category, each scored as a
 * delta against the player's own baseline, averaged. Higher average wins.
 *
 *     delta_i     = (score_i - baseline_i) / baseline_i
 *     matchScore  = mean(delta_1, delta_2, delta_3)
 *
 * Normalising against each player's own baseline is what lets any two players have a
 * real contest: the question becomes "who showed up sharper today" rather than "who
 * has more hours on this scenario". The cost is legibility: **you can score higher and
 * still lose**, so every consumer of this module must show raw scores, baselines and
 * deltas together. Hiding the working is how players conclude the app is broken.
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

export interface SettlementInput {
  playerRounds: RoundSubmission[];
  opponentRounds: RoundSubmission[];
}

export interface Settlement {
  player: SideOutcome;
  opponent: SideOutcome;
  verdict: MatchVerdict;
  /** Why the match was voided, when it was. */
  voidReason?: string;
  /**
   * Weight to apply to the rating update, 0..1. Reduced when either side relied on
   * provisional baselines, so a placement-quality match cannot swing a settled rating.
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
export function settleSide(rounds: RoundSubmission[]): SideOutcome {
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
  const matchScore =
    counted.length > 0
      ? counted.reduce((sum, r) => sum + (r.delta ?? 0), 0) / counted.length
      : null;

  return {
    rounds: outcomes,
    matchScore,
    countedRounds: counted.length,
    provisional: counted.some((r) => r.provisional),
  };
}

export function settleMatch(input: SettlementInput): Settlement {
  const player = settleSide(input.playerRounds);
  const opponent = settleSide(input.opponentRounds);

  // A match is only meaningful if both sides completed the same rounds. Anything else
  // is voided rather than guessed at, since a partial match that still moved rating would
  // be a straightforward way to farm a favourable result.
  if (player.countedRounds === 0 || opponent.countedRounds === 0) {
    return {
      player,
      opponent,
      verdict: "void",
      voidReason: "one side has no countable rounds",
      ratingWeight: 0,
    };
  }

  if (player.countedRounds !== opponent.countedRounds) {
    // Name abandonment for what it is. This string is shown to the player, and "you
    // completed 2 rounds and they completed 3" reads like the app lost track of
    // something, which is the impression a void must not leave.
    const abandonedRounds = [...player.rounds, ...opponent.rounds].filter(
      (r) => r.abandoned,
    );

    return {
      player,
      opponent,
      verdict: "void",
      voidReason:
        abandonedRounds.length > 0
          ? `a scenario was left before it finished (${abandonedRounds
              .map((r) => r.scenarioName)
              .join(", ")})`
          : `sides completed different numbers of rounds ` +
            `(${player.countedRounds} vs ${opponent.countedRounds})`,
      ratingWeight: 0,
    };
  }

  const a = player.matchScore ?? 0;
  const b = opponent.matchScore ?? 0;
  const gap = a - b;

  const verdict: MatchVerdict =
    Math.abs(gap) < DRAW_EPSILON ? "draw" : gap > 0 ? "win" : "loss";

  const ratingWeight =
    player.provisional || opponent.provisional ? PROVISIONAL_WEIGHT : 1;

  return { player, opponent, verdict, ratingWeight };
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
 * Exists because "you scored more and lost" is a real and legitimate outcome of this
 * format, and it has to be explained the moment it happens rather than discovered.
 */
export function explainVerdict(settlement: Settlement): string {
  if (settlement.verdict === "void") {
    return `Match void: ${settlement.voidReason ?? "incomplete"}.`;
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
