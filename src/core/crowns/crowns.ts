/**
 * Crowns: an asynchronous king of the hill, one per category and band.
 *
 * Apogee matches are won on delta over the player's own baseline (PLAN.md §3), which is
 * what lets any player contest any other. A Crown uses that directly. It is held by one
 * stored run set on three fixed scenarios. Anybody may challenge it by playing the same
 * three; if their match score beats the holder's, they take it and their run set becomes
 * the one to beat.
 *
 * WHERE THE RULES LIVE
 *
 * Here, as a pure reducer, and again in SQL (`crown_resolve` and friends in migration
 * 20261003000025), because the decision has to be taken inside the transaction that locks
 * the Crown. Two copies of a rule drift, so `tools/validateCrownsDb.ts` drives the real
 * SQL and this reducer through the same random sequences and requires the same holder,
 * the same defences and the same notices out of both. This file is the specification;
 * the SQL is the enforcement.
 *
 * THE RULES, IN ONE PLACE
 *
 *   seeding     A vacant Crown is claimed by playing its three. The first qualifying run
 *               set to settle takes it. The three are drawn when the first claim opens,
 *               so every claimant in that cycle plays the same scenarios.
 *   taking      A challenger takes the Crown when their match score is at least
 *               CROWN_DRAW_EPSILON above the holder's: the same margin settleMatch needs
 *               to call a round a win rather than a draw.
 *   ties        A draw is a defence. The holder keeps it.
 *   judged by   whoever holds the Crown when the challenge settles. If it changed hands
 *               while the challenger was playing, they are judged against the new holder,
 *               on the same three scenarios. The holder at the end is then the best run
 *               set posted, whatever order simultaneous challenges settle in.
 *   defences    One per distinct challenger beaten in a reign. A challenger who loses
 *               twice is one defence, so an alt account cannot pad the count.
 *   qualifying  Settled, every round counted, every run Verified or Consistent. Suspect
 *               runs are held for review in ranked and a Crown is a public title, so they
 *               do not take one. A Rejected run never counts for anything.
 *   cooldown    One challenge per player per Crown every CHALLENGE_COOLDOWN_MS, whatever
 *               it came to. A void or a forfeit spends it too, or quitting a bad run
 *               would be a free reroll.
 *   own Crown   A holder cannot challenge their own Crown. Only other players defend it.
 *   lapse       A reign ends REIGN_CAP_MS after it began. The Crown falls vacant and the
 *               next claim draws three new scenarios. A lapse waits for a challenge that
 *               is already being played, so nobody loses a chance mid-match.
 *   rating      None. Crown matches are unrated (`matches.rated = false`, the path
 *               tournaments use) and never enter the ranked pool.
 */

import type { VerificationTier } from "../verify/verifyRun.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * How long a reign may last.
 *
 * Measured rather than chosen, in the sense that the alternative was measured: with
 * players drawn from one distribution, the holder after m qualifying run sets is the best
 * of m, so the next challenger takes it with probability 1/(m+1) and the expected number
 * of changes of hand in a cycle grows only as ln(m). Without a cap the board freezes:
 * `validateCrowns.ts` replays eight weeks at five players and finds the last week of an
 * uncapped Crown changing hands a fraction as often as a capped one. Seven days is a week
 * of evenings, the unit PLAN.md §6 already uses for duels.
 */
export const REIGN_CAP_MS = 7 * DAY;

/**
 * How often one player may challenge one Crown.
 *
 * The three scenarios are fixed for a cycle, so unlimited attempts would hand the Crown to
 * whoever has the most evenings to spend: the best of k tries beats one try k times in
 * k+1. One a day per Crown puts every player on the same number of draws. Twenty hours
 * rather than twenty-four, so somebody who plays at about the same time each evening is
 * not refused by a few minutes.
 */
export const CHALLENGE_COOLDOWN_MS = 20 * HOUR;

/**
 * The margin a challenger needs: settleMatch's own DRAW_EPSILON (src/core/match/settle.ts).
 *
 * Restated rather than imported because settle.ts does not export it, and
 * `validateCrowns.ts` holds the two together by asking settleMatch for its verdict on the
 * same pairs of scores.
 */
export const CROWN_DRAW_EPSILON = 0.0005;

/** The verification tiers that may wear a Crown. */
export const CROWN_TIERS: readonly VerificationTier[] = ["verified", "consistent"];

export type RunTier = VerificationTier | "unverified";

/** What settlement stored for the challenger's side, as the Crown needs to read it. */
export interface RunSet {
  /** Terminal status of the challenge match. */
  status: "settled" | "void";
  /** The side's stored match score; null for a forfeit or anything voided. */
  matchScore: number | null;
  /** One tier per scenario the side has a run for. */
  tiers: RunTier[];
  /** How many scenarios the match had. */
  scenarios: number;
  /** True when the side ended by forfeit (abandoned or ran out of time). */
  forfeit?: boolean;
  provisional?: boolean;
}

export type Outcome = "took" | "defended" | "void" | "forfeit" | "stale";

export interface Reign {
  id: string;
  holderId: string;
  /** The match the holder's run set was played in. */
  matchId: string;
  matchScore: number;
  startedAt: number;
  /** Distinct challengers beaten in this reign. */
  defences: number;
  /** Every qualifying challenge this reign survived, repeats included. */
  challenges: number;
  defeated: string[];
  lowestTier: RunTier;
  provisional: boolean;
}

export interface CrownState {
  category: string;
  window: number;
  /** Bumps every time the Crown falls vacant. One cycle, one set of three scenarios. */
  cycle: number;
  scenarioIds: number[] | null;
  reign: Reign | null;
}

export interface Challenge {
  matchId: string;
  challengerId: string;
  cycle: number;
  /** The reign it was opened against; null for a claim on a vacant Crown. */
  reignId: string | null;
  openedAt: number;
}

export type NoticeKind = "dethroned" | "defended" | "lapsed" | "reset";

export interface Notice {
  playerId: string;
  kind: NoticeKind;
  category: string;
  window: number;
  reignId: string;
  otherId: string | null;
  defences: number;
  reignMs: number;
  challengerScore: number | null;
  holderScore: number | null;
}

export interface Judgement {
  outcome: Outcome;
  state: CrownState;
  /** The reign this challenge was measured against, if any. */
  judgedReignId: string | null;
  /** A reign that ended because of this challenge. */
  ended: (Reign & { endedAt: number; endReason: "dethroned"; endedBy: string }) | null;
  notice: Notice | null;
  reason: string;
}

/** Whether a stored side may take or seed a Crown, and if not, what it counts as. */
export function qualifies(set: RunSet): { ok: true } | { ok: false; outcome: "void" | "forfeit"; reason: string } {
  if (set.forfeit) return { ok: false, outcome: "forfeit", reason: "the challenge was abandoned or ran out of time" };
  if (set.status !== "settled" || set.matchScore == null || !Number.isFinite(set.matchScore)) {
    return { ok: false, outcome: "void", reason: "the match did not count" };
  }
  if (set.tiers.length !== set.scenarios) {
    return { ok: false, outcome: "void", reason: "not every scenario has a run" };
  }
  if (set.tiers.some((t) => t === "rejected")) {
    return { ok: false, outcome: "void", reason: "a run failed verification" };
  }
  if (!set.tiers.every((t) => (CROWN_TIERS as readonly string[]).includes(t))) {
    return { ok: false, outcome: "void", reason: "a run is held for review, and a Crown needs Verified or Consistent runs" };
  }
  return { ok: true };
}

/** Does the challenger's match score take the Crown from the holder's? A draw does not. */
export function beats(challenger: number, holder: number): boolean {
  return challenger - holder >= CROWN_DRAW_EPSILON;
}

const TIER_ORDER: RunTier[] = ["verified", "consistent", "suspect", "unverified", "rejected"];

/** The weakest tier among a run set's runs, which is what a Crown can honestly claim. */
export function lowestTier(tiers: RunTier[]): RunTier {
  let worst = 0;
  for (const t of tiers) worst = Math.max(worst, TIER_ORDER.indexOf(t));
  return TIER_ORDER[worst] ?? "unverified";
}

/**
 * Decide one settled challenge.
 *
 * Pure: the caller supplies the Crown as it is now (locked, on the server), the challenge,
 * what settlement stored for the challenger, the time, and the id the new reign would get.
 */
export function judge(
  state: CrownState,
  challenge: Challenge,
  set: RunSet,
  now: number,
  newReignId: string,
): Judgement {
  const current = state.reign;
  const same = (reason: string, outcome: Outcome): Judgement => ({
    outcome,
    state,
    judgedReignId: null,
    ended: null,
    notice: null,
    reason,
  });

  const valid = qualifies(set);
  if (!valid.ok) return same(valid.reason, valid.outcome);

  // The Crown reset under the challenge (it lapsed while the match had already expired,
  // or the season dropped its scenarios), so it was played on a different three.
  if (challenge.cycle !== state.cycle) return same("the Crown moved on to new scenarios while this was played", "stale");

  const score = set.matchScore as number;
  const reign = (): Reign => ({
    id: newReignId,
    holderId: challenge.challengerId,
    matchId: challenge.matchId,
    matchScore: score,
    startedAt: now,
    defences: 0,
    challenges: 0,
    defeated: [],
    lowestTier: lowestTier(set.tiers),
    provisional: !!set.provisional,
  });

  // A claim, or a challenge whose holder's reign ended some other way: the Crown is empty,
  // and the first qualifying run set to settle fills it.
  if (!current) {
    return {
      outcome: "took",
      state: { ...state, reign: reign() },
      judgedReignId: null,
      ended: null,
      notice: null,
      reason: "the Crown was vacant",
    };
  }

  // Nobody can hold two open matches, so this cannot happen through the functions; it is
  // here so a hand-made row cannot make a holder defend against themselves.
  if (current.holderId === challenge.challengerId) return same("a holder cannot challenge their own Crown", "stale");

  if (beats(score, current.matchScore)) {
    const ended = { ...current, endedAt: now, endReason: "dethroned" as const, endedBy: challenge.challengerId };
    return {
      outcome: "took",
      state: { ...state, reign: reign() },
      judgedReignId: current.id,
      ended,
      notice: {
        playerId: current.holderId,
        kind: "dethroned",
        category: state.category,
        window: state.window,
        reignId: current.id,
        otherId: challenge.challengerId,
        defences: current.defences,
        reignMs: now - current.startedAt,
        challengerScore: score,
        holderScore: current.matchScore,
      },
      reason: "beat the holder's match score",
    };
  }

  const repeat = current.defeated.includes(challenge.challengerId);
  const defended: Reign = {
    ...current,
    defences: current.defences + (repeat ? 0 : 1),
    challenges: current.challenges + 1,
    defeated: repeat ? current.defeated : [...current.defeated, challenge.challengerId],
  };
  return {
    outcome: "defended",
    state: { ...state, reign: defended },
    judgedReignId: current.id,
    ended: null,
    notice: {
      playerId: current.holderId,
      kind: "defended",
      category: state.category,
      window: state.window,
      reignId: current.id,
      otherId: challenge.challengerId,
      defences: defended.defences,
      reignMs: now - current.startedAt,
      challengerScore: score,
      holderScore: current.matchScore,
    },
    reason: beats(current.matchScore, score) ? "did not beat the holder's match score" : "drew with the holder, and a draw is a defence",
  };
}

/** Has this reign run its course? A challenge still being played holds it open. */
export function lapseDue(state: CrownState, now: number, liveChallengeOnReign: boolean): boolean {
  if (!state.reign) return false;
  if (liveChallengeOnReign) return false;
  return now - state.reign.startedAt >= REIGN_CAP_MS;
}

/** End a reign at the cap (or on a reset) and empty the Crown for a new cycle. */
export function vacate(
  state: CrownState,
  now: number,
  kind: "lapsed" | "reset",
): { state: CrownState; notice: Notice | null } {
  const reign = state.reign;
  const next: CrownState = { ...state, reign: null, cycle: state.cycle + 1, scenarioIds: null };
  if (!reign) return { state: next, notice: null };
  return {
    state: next,
    notice: {
      playerId: reign.holderId,
      kind,
      category: state.category,
      window: state.window,
      reignId: reign.id,
      otherId: null,
      defences: reign.defences,
      reignMs: now - reign.startedAt,
      challengerScore: null,
      holderScore: reign.matchScore,
    },
  };
}

export type Refusal =
  | { ok: true }
  | { ok: false; code: "holder" | "cooldown" | "busy"; reason: string; availableAt?: number };

/** May this player open a challenge on this Crown now? The SQL asks the same three things. */
export function canChallenge(
  state: CrownState,
  playerId: string,
  lastChallengeAt: number | null,
  now: number,
  hasLiveMatch: boolean,
): Refusal {
  if (state.reign?.holderId === playerId) {
    return { ok: false, code: "holder", reason: "You hold this Crown. Other players defend it for you by challenging it." };
  }
  if (lastChallengeAt != null && now - lastChallengeAt < CHALLENGE_COOLDOWN_MS) {
    const availableAt = lastChallengeAt + CHALLENGE_COOLDOWN_MS;
    return {
      ok: false,
      code: "cooldown",
      reason: `One challenge per Crown every 20 hours. You can challenge this one again in ${duration(availableAt - now)}.`,
      availableAt,
    };
  }
  if (hasLiveMatch) return { ok: false, code: "busy", reason: "Finish or abandon your current match first." };
  return { ok: true };
}

/** "2 days 4 hours", "3 hours 10 minutes", "40 minutes". Never "0 minutes". */
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day");
  if (hours > 0) return mins > 0 ? `${unit(hours, "hour")} ${unit(mins, "minute")}` : unit(hours, "hour");
  return unit(mins, "minute");
}

/** "after 3 defences", "after 1 defence", "before your first defence". */
export function defencePhrase(defences: number): string {
  if (defences <= 0) return "before your first defence";
  return `after ${defences} defence${defences === 1 ? "" : "s"}`;
}

/** A Crown's name as a player reads it: "Precise Tracking Crown (Intermediate)". */
export function crownName(category: string, band: string | null | undefined): string {
  return band ? `${category} Crown (${band})` : `${category} Crown`;
}

/** The sentence a notice is shown as, the next time its owner opens the client. */
export function noticeText(
  notice: Pick<Notice, "kind" | "defences" | "reignMs" | "category">,
  band: string | null | undefined,
  otherName: string | null,
): string {
  const crown = crownName(notice.category, band);
  const who = otherName || "another player";
  switch (notice.kind) {
    case "dethroned":
      return `You lost the ${crown} to ${who} ${defencePhrase(notice.defences)}. You held it for ${duration(notice.reignMs)}.`;
    case "defended":
      return `${who} challenged your ${crown} and did not take it. Defences this reign: ${notice.defences}.`;
    case "lapsed":
      return `Your reign over the ${crown} reached its 7-day limit with ${notice.defences} defence${notice.defences === 1 ? "" : "s"}. It is vacant again, on three new scenarios.`;
    case "reset":
      return `The season no longer has your ${crown} scenarios, so the Crown was reset after ${duration(notice.reignMs)}. It is vacant again.`;
  }
}
