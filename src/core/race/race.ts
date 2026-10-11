/**
 * Live race: two players on the same three scenarios at the same time, and a per-round
 * reveal as each run lands.
 *
 * A race is two ordinary one-sided matches created in one transaction with the same three
 * scenarios and the same start, linked by a `races` row (migration 20261011000005). Each
 * side plays, submits and settles through the paths that already exist; nothing about
 * verification, baselines or settlement changes. The race is decided the way every ranked
 * match is since ranked v2 (PLAN.md §3): each scenario is a round won by the higher raw
 * score, and whoever wins more rounds wins. Equal rounds is a draw. Nothing is rated.
 *
 * THE ONE RULE THAT MAKES IT FAIR: SEALED ROUNDS
 *
 * You see the other side's score on a round only once your own run on that scenario has
 * landed. Until then you see that they have landed it, never what they scored. Your first
 * run on a scenario is the one that counts (PLAN.md §3), so by the time a round is revealed
 * to you there is nothing left you can do about it. Playing second therefore buys no
 * information, and stalling to watch is capped by the match clock anyway.
 *
 * The same rule serves a Crown challenge, where the other side is the holder's frozen run
 * set: each of the holder's scores is revealed as your run on that scenario lands.
 *
 * WHERE IT IS ENFORCED
 *
 * In `race-status`, on the server. For a race the other player's match is not readable by
 * you at all (you have no side in it). For a Crown challenge the holder's raw scores are
 * not copied into your match (settlement finds them on the holder's own side), and the
 * Crown tables are closed to clients, so there too race-status is the only route to them.
 */

import type { RunTier } from "../crowns/crowns.ts";

/** How long an invitation to race waits for an answer. Minutes: a race is for now. */
export const RACE_INVITE_TTL_MS = 3 * 60_000;

/** How long a declined invitation keeps its sender from asking the same player again. */
export const DECLINE_QUIET_MS = 10 * 60_000;

export interface LiveRound {
  scenarioId: number;
  scenario: string;
  landed: boolean;
  /** Raw score: what the round is decided on. Null when not landed or not counted. */
  score: number | null;
  /** Against the player's own usual (signed fraction of their baseline). Information only. */
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
}

export type RoundResult = "won" | "lost" | "tied";

export interface SealedRound {
  scenarioId: number;
  scenario: string;
  you: { landed: boolean; score: number | null; delta: number | null; counted: boolean; provisional: boolean; tier: RunTier | null };
  them: { landed: boolean; sealed: boolean; score: number | null; counted: boolean | null };
  /** Decided once both scores are visible and both runs counted. */
  result: RoundResult | null;
}

export interface Tally {
  won: number;
  lost: number;
  tied: number;
}

export interface SealedView {
  rounds: SealedRound[];
  you: { name: string; landed: number; terminal: boolean };
  them: { name: string; landed: number; terminal: boolean };
  /** Rounds decided so far, from the viewer's side: the tug-of-war bar. */
  tally: Tally;
}

/** May the viewer see the other side's round i yet? */
export function revealed(viewer: LiveSide, i: number): boolean {
  return viewer.terminal || !!viewer.rounds[i]?.landed;
}

/** One round, raw score against raw score. */
export function roundResult(mine: number, theirs: number): RoundResult {
  return mine > theirs ? "won" : mine < theirs ? "lost" : "tied";
}

/**
 * The view one player is allowed: everything of theirs, and the other side's score on a
 * round only where their own run on it has landed.
 */
export function sealView(viewer: LiveSide, opponent: LiveSide): SealedView {
  const rounds: SealedRound[] = viewer.rounds.map((mine, i) => {
    const theirs = opponent.rounds[i];
    const open = revealed(viewer, i);
    const themLanded = !!theirs?.landed;
    const themScore = open && themLanded && theirs.counted ? theirs.score : null;
    const result =
      mine.landed && mine.counted && mine.score != null && themScore != null ? roundResult(mine.score, themScore) : null;
    return {
      scenarioId: mine.scenarioId,
      scenario: mine.scenario,
      you: {
        landed: mine.landed,
        score: mine.counted ? mine.score : null,
        delta: mine.counted ? mine.delta : null,
        counted: mine.counted,
        provisional: mine.provisional,
        tier: mine.tier,
      },
      them: {
        landed: themLanded,
        sealed: themLanded && !open,
        score: themScore,
        counted: open && themLanded ? theirs.counted : null,
      },
      result,
    };
  });
  const tally: Tally = {
    won: rounds.filter((r) => r.result === "won").length,
    lost: rounds.filter((r) => r.result === "lost").length,
    tied: rounds.filter((r) => r.result === "tied").length,
  };
  return {
    rounds,
    you: { name: viewer.name, landed: viewer.rounds.filter((r) => r.landed).length, terminal: viewer.terminal },
    them: { name: opponent.name, landed: opponent.rounds.filter((r) => r.landed).length, terminal: opponent.terminal },
    tally,
  };
}

/** What settlement stored for one leg, as far as the race result needs it. */
export interface FinalLeg {
  status: "settled" | "void";
  /** Raw score per scenario, in scenario order. */
  scores: number[] | null;
  tiers: RunTier[];
  scenarios: number;
}

/** A leg finished: settled, a raw score on every scenario, and no run rejected. */
export function legFinished(leg: FinalLeg): boolean {
  return (
    leg.status === "settled" &&
    Array.isArray(leg.scores) &&
    leg.scores.length === leg.scenarios &&
    leg.scores.every((x) => typeof x === "number" && Number.isFinite(x)) &&
    leg.tiers.length === leg.scenarios &&
    leg.tiers.every((t) => t !== "rejected" && t !== "unverified")
  );
}

export type RaceResult = "inviter" | "invitee" | "draw" | "void";

/** Rounds won, lost and tied by `a` against `b`, scenario by scenario. */
export function raceTally(a: number[], b: number[]): Tally {
  const t: Tally = { won: 0, lost: 0, tied: 0 };
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const r = roundResult(a[i], b[i]);
    if (r === "won") t.won++;
    else if (r === "lost") t.lost++;
    else t.tied++;
  }
  return t;
}

/**
 * Who won, once both legs have ended.
 *
 * On the round tally, raw score against raw score; equal rounds is a draw. A leg that did
 * not finish loses to one that did, whatever the reason: the race is unrated, so a crash
 * costs nothing, and the alternative lets anybody who is behind quit and deny the other
 * player a result they played for. Neither finishing is a void.
 */
export function raceVerdict(inviter: FinalLeg, invitee: FinalLeg): { result: RaceResult; byForfeit: boolean; tally: Tally | null; reason: string } {
  const a = legFinished(inviter);
  const b = legFinished(invitee);
  if (!a && !b) return { result: "void", byForfeit: false, tally: null, reason: "neither side finished all three" };
  if (a && !b) return { result: "inviter", byForfeit: true, tally: null, reason: "the other side did not finish" };
  if (!a && b) return { result: "invitee", byForfeit: true, tally: null, reason: "the other side did not finish" };
  const t = raceTally(inviter.scores as number[], invitee.scores as number[]);
  if (t.won === t.lost) return { result: "draw", byForfeit: false, tally: t, reason: "level on rounds" };
  return { result: t.won > t.lost ? "inviter" : "invitee", byForfeit: false, tally: t, reason: "more rounds won" };
}

/** The race from one player's side: "You won", "You lost", "Draw", "Void". */
export function verdictFor(result: RaceResult | null, viewerIsInviter: boolean): "win" | "loss" | "draw" | "void" | null {
  if (result == null) return null;
  if (result === "draw" || result === "void") return result;
  return (result === "inviter") === viewerIsInviter ? "win" : "loss";
}
