/**
 * Live race: two players on the same three scenarios at the same time, and a per-round
 * reveal as each run lands.
 *
 * A race is two ordinary one-sided matches created in one transaction with the same three
 * scenarios and the same start, linked by a `races` row (migration 20261003000025). Each
 * side plays, submits and settles through the paths that already exist; nothing about
 * verification, baselines or settlement changes. The race result is read off the two
 * stored sides once both have ended. Nothing is rated.
 *
 * THE ONE RULE THAT MAKES IT FAIR: SEALED ROUNDS
 *
 * You see the other side's round only once your own run on that scenario has landed.
 * Until then you see that they have landed it, never how well. Your first run on a
 * scenario is the one that counts (PLAN.md §3), so by the time a round is revealed to you
 * there is nothing left you can do about it. Playing second therefore buys no information:
 * the one advantage a simultaneous format usually hands the slower player is gone, and
 * stalling to watch is capped by the match clock anyway.
 *
 * The same rule serves a Crown challenge, where the other side is the holder's frozen
 * run set: each of the holder's rounds is revealed as your run on it lands.
 *
 * WHERE IT IS ENFORCED
 *
 * In `race-status`, on the server. For a race the other player's match is not readable by
 * you at all (you have no side in it), so the only way to their rounds is through this
 * rule. For a Crown challenge the holder's copied side is readable by any participant, as
 * every copied side in ranked is, so there the sealing is presentation and is documented
 * as such in docs/fleet/arena.md.
 */

import type { RunTier } from "../crowns/crowns.ts";

/** How long an invitation to race waits for an answer. Minutes: a race is for now. */
export const RACE_INVITE_TTL_MS = 3 * 60_000;

/** settleMatch's DRAW_EPSILON, restated for the same reason crowns.ts restates it. */
export const RACE_DRAW_EPSILON = 0.0005;

export interface LiveRound {
  scenarioId: number;
  scenario: string;
  landed: boolean;
  /** Signed fraction over the player's own baseline; null when not landed or not counted. */
  delta: number | null;
  counted: boolean;
  provisional: boolean;
  tier: RunTier | null;
}

export interface LiveSide {
  name: string;
  rounds: LiveRound[];
  /** The side's match has ended (settled or void). */
  terminal: boolean;
  void: boolean;
  matchScore: number | null;
}

export interface SealedRound {
  scenarioId: number;
  scenario: string;
  you: { landed: boolean; delta: number | null; counted: boolean; provisional: boolean; tier: RunTier | null };
  them: { landed: boolean; sealed: boolean; delta: number | null; counted: boolean | null };
  /** your delta minus theirs, when both are visible and counted. */
  margin: number | null;
}

export interface SealedView {
  rounds: SealedRound[];
  you: { name: string; landed: number; terminal: boolean; matchScore: number | null };
  them: { name: string; landed: number; terminal: boolean; matchScore: number | null };
  /** Mean margin over the rounds both sides have revealed: the tug-of-war bar. */
  margin: number | null;
  marginRounds: number;
}

/** May the viewer see the other side's round i yet? */
export function revealed(viewer: LiveSide, i: number): boolean {
  return viewer.terminal || !!viewer.rounds[i]?.landed;
}

/**
 * The view one player is allowed: everything of theirs, and the other side's rounds only
 * where their own run has landed. The other side's match score is shown only once the
 * viewer's own match has ended, because a mean is three rounds at once.
 */
export function sealView(viewer: LiveSide, opponent: LiveSide): SealedView {
  const rounds: SealedRound[] = viewer.rounds.map((mine, i) => {
    const theirs = opponent.rounds[i];
    const open = revealed(viewer, i);
    const themLanded = !!theirs?.landed;
    const themDelta = open && themLanded && theirs.counted ? theirs.delta : null;
    const margin =
      mine.landed && mine.counted && mine.delta != null && themDelta != null ? mine.delta - themDelta : null;
    return {
      scenarioId: mine.scenarioId,
      scenario: mine.scenario,
      you: { landed: mine.landed, delta: mine.counted ? mine.delta : null, counted: mine.counted, provisional: mine.provisional, tier: mine.tier },
      them: {
        landed: themLanded,
        sealed: themLanded && !open,
        delta: themDelta,
        counted: open && themLanded ? theirs.counted : null,
      },
      margin,
    };
  });
  const margins = rounds.map((r) => r.margin).filter((m): m is number => m != null);
  return {
    rounds,
    you: {
      name: viewer.name,
      landed: viewer.rounds.filter((r) => r.landed).length,
      terminal: viewer.terminal,
      matchScore: viewer.matchScore,
    },
    them: {
      name: opponent.name,
      landed: opponent.rounds.filter((r) => r.landed).length,
      terminal: opponent.terminal,
      matchScore: viewer.terminal ? opponent.matchScore : null,
    },
    margin: margins.length > 0 ? margins.reduce((a, b) => a + b, 0) / margins.length : null,
    marginRounds: margins.length,
  };
}

/** What settlement stored for one leg, as far as the race result needs it. */
export interface FinalLeg {
  status: "settled" | "void";
  matchScore: number | null;
  tiers: RunTier[];
  scenarios: number;
}

/** A leg finished: settled, scored, a run on every scenario and none of them rejected. */
export function legFinished(leg: FinalLeg): boolean {
  return (
    leg.status === "settled" &&
    leg.matchScore != null &&
    Number.isFinite(leg.matchScore) &&
    leg.tiers.length === leg.scenarios &&
    leg.tiers.every((t) => t !== "rejected" && t !== "unverified")
  );
}

export type RaceResult = "inviter" | "invitee" | "draw" | "void";

/**
 * Who won, once both legs have ended.
 *
 * A leg that did not finish loses to one that did, whatever the reason: the race is
 * unrated, so a crash costs nothing, and the alternative lets anybody who is behind quit
 * and deny the other player a result they played for. Neither finishing is a void.
 */
export function raceVerdict(inviter: FinalLeg, invitee: FinalLeg): { result: RaceResult; byForfeit: boolean; reason: string } {
  const a = legFinished(inviter);
  const b = legFinished(invitee);
  if (!a && !b) return { result: "void", byForfeit: false, reason: "neither side finished all three" };
  if (a && !b) return { result: "inviter", byForfeit: true, reason: "the other side did not finish" };
  if (!a && b) return { result: "invitee", byForfeit: true, reason: "the other side did not finish" };
  const gap = (inviter.matchScore as number) - (invitee.matchScore as number);
  if (Math.abs(gap) < RACE_DRAW_EPSILON) return { result: "draw", byForfeit: false, reason: "level within the draw margin" };
  return { result: gap > 0 ? "inviter" : "invitee", byForfeit: false, reason: "higher match score" };
}

/** The race from one player's side: "You won", "You lost", "Draw", "Void". */
export function verdictFor(result: RaceResult | null, viewerIsInviter: boolean): "win" | "loss" | "draw" | "void" | null {
  if (result == null) return null;
  if (result === "draw" || result === "void") return result;
  return (result === "inviter") === viewerIsInviter ? "win" : "loss";
}
