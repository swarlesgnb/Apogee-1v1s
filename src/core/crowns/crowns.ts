/**
 * Crowns: an asynchronous king of the hill, one per category and band.
 *
 * A Crown is held by one stored run set on three fixed scenarios. Anybody may challenge it
 * by playing the same three. Each scenario is a round, won by the higher raw score, the
 * way every ranked match is decided since ranked v2 (PLAN.md §3). A challenger who wins
 * more rounds than the holder takes the Crown, and their three become the ones to beat.
 *
 * WHERE THE RULES LIVE
 *
 * Here, as a pure reducer, and again in SQL (`crown_resolve` and friends in migration
 * 20261011000005), because the decision has to be taken inside the transaction that locks
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
 *   taking      Round by round on raw score, as settleMatch's rounds format decides a
 *               match: the challenger takes the Crown by winning more rounds than they lose.
 *   ties        A tied tally (1-1 with one round level, or 0-0 with three) is a defence.
 *               The holder keeps it.
 *   judged by   whoever holds the Crown when the challenge settles. If it changed hands
 *               while the challenger was playing, they are judged against the new holder's
 *               scores, on the same three scenarios.
 *   defences    One per distinct challenger beaten in a reign. A challenger who loses
 *               twice is one defence, so an alt account cannot pad the count.
 *   qualifying  Settled, a raw score on every scenario, every run Verified or Consistent.
 *               Suspect runs are held for review in ranked and a Crown is a public title,
 *               so they do not take one. A Rejected run never counts for anything.
 *   cooldown    One challenge per player per Crown every CHALLENGE_COOLDOWN_MS, whatever
 *               it came to. A void or a forfeit spends it too, or quitting a bad run
 *               would be a free reroll.
 *   own Crown   A holder cannot challenge their own Crown. Only other players defend it.
 *   lapse       A reign ends REIGN_CAP_MS after it began. The Crown falls vacant and the
 *               next claim draws three new scenarios. A lapse waits for a challenge that
 *               is already being played, so nobody loses a chance mid-match.
 *   rating      None. Crown matches are unrated (`matches.rated = false`, the path
 *               tournaments use) and never enter the ranked pool.
 *
 * A round majority is not transitive: A can beat B 2-1 and B beat C 2-1 while C beats A.
 * So when challenges settle at once the holder at the end can depend on the order they
 * settle in. Each is still judged against exactly one holder, each reign still ends at
 * most once, and every take beat the holder it took from (validateCrowns.ts checks all
 * three); "the best run set wins whatever the order" held under mean delta and does not
 * under rounds, and docs/fleet/arena.md says so.
 */

import type { VerificationTier } from "../verify/verifyRun.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * How long a reign may last.
 *
 * Measured rather than chosen, in the sense that the alternative was measured: the holder's
 * three are the survivors of every challenge so far, so each new challenger faces a set
 * that has already beaten everybody before them, and without a cap the board freezes.
 * `validateCrowns.ts` replays eight weeks of raw-score rounds and finds the last week of an
 * uncapped Crown changing hands a fraction as often as a capped one. Seven days is a week
 * of evenings, the unit PLAN.md §6 already uses for duels.
 */
export const REIGN_CAP_MS = 7 * DAY;

/**
 * How often one player may challenge one Crown.
 *
 * The three scenarios are fixed for a cycle, so unlimited attempts would hand the Crown to
 * whoever has the most evenings to spend: more tries at the same three is more chances at
 * a lucky set. One a day per Crown puts every player on the same number of draws. Twenty
 * hours rather than twenty-four, so somebody who plays at about the same time each evening
 * is not refused by a few minutes.
 */
export const CHALLENGE_COOLDOWN_MS = 20 * HOUR;

/** The verification tiers that may wear a Crown. */
export const CROWN_TIERS: readonly VerificationTier[] = ["verified", "consistent"];

export type RunTier = VerificationTier | "unverified";

/** What settlement stored for the challenger's side, as the Crown needs to read it. */
export interface RunSet {
  /** Terminal status of the challenge match. */
  status: "settled" | "void";
  /** Raw score per scenario, in the match's scenario order; null for a forfeit or a void. */
  scores: number[] | null;
  /** One tier per scenario the side has a run for. */
  tiers: RunTier[];
  /** How many scenarios the match had. */
  scenarios: number;
  /** True when the side ended by forfeit (abandoned or ran out of time). */
  forfeit?: boolean;
  /** Mean delta against the player's own baselines: shown as "against your usual", decides nothing. */
  meanDelta?: number | null;
  provisional?: boolean;
}

export type Outcome = "took" | "defended" | "void" | "forfeit" | "stale";

export interface Tally {
  won: number;
  lost: number;
  tied: number;
}

export interface Reign {
  id: string;
  holderId: string;
  /** The match the holder's run set was played in. */
  matchId: string;
  /** The holder's raw score per scenario. Sealed from challengers until their run on it lands. */
  scores: number[];
  meanDelta: number | null;
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
  /** Rounds the challenger won and the holder won, for a take or a defence. */
  challengerRounds: number | null;
  holderRounds: number | null;
}

export interface Judgement {
  outcome: Outcome;
  state: CrownState;
  /** The reign this challenge was measured against, if any. */
  judgedReignId: string | null;
  /** The round tally against that reign, from the challenger's side. */
  tally: Tally | null;
  /** A reign that ended because of this challenge. */
  ended: (Reign & { endedAt: number; endReason: "dethroned"; endedBy: string }) | null;
  notice: Notice | null;
  reason: string;
}

const finiteScores = (s: number[] | null | undefined, n: number): s is number[] =>
  Array.isArray(s) && s.length === n && s.every((x) => typeof x === "number" && Number.isFinite(x));

/** Whether a stored side may take or seed a Crown, and if not, what it counts as. */
export function qualifies(set: RunSet): { ok: true } | { ok: false; outcome: "void" | "forfeit"; reason: string } {
  if (set.forfeit) return { ok: false, outcome: "forfeit", reason: "the challenge was abandoned or ran out of time" };
  if (set.status !== "settled" || !finiteScores(set.scores, set.scenarios)) {
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

/** Rounds won, lost and tied on raw score, from the challenger's side. Round i is scenario i. */
export function tally(challenger: number[], holder: number[]): Tally {
  const t: Tally = { won: 0, lost: 0, tied: 0 };
  for (let i = 0; i < Math.min(challenger.length, holder.length); i++) {
    if (challenger[i] > holder[i]) t.won++;
    else if (challenger[i] < holder[i]) t.lost++;
    else t.tied++;
  }
  return t;
}

/** Does the challenger take the Crown? More rounds won than lost. A tied tally does not. */
export function beats(challenger: number[], holder: number[]): boolean {
  const t = tally(challenger, holder);
  return t.won > t.lost;
}

/** "2-1", "1-0 with two level". */
export function tallyText(t: Tally): string {
  return `${t.won}–${t.lost}${t.tied > 0 ? ` with ${t.tied === 1 ? "one" : t.tied === 2 ? "two" : "three"} level` : ""}`;
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
    tally: null,
    ended: null,
    notice: null,
    reason,
  });

  const valid = qualifies(set);
  if (!valid.ok) return same(valid.reason, valid.outcome);

  // The Crown reset under the challenge (it lapsed while the match had already expired,
  // or the season dropped its scenarios), so it was played on a different three.
  if (challenge.cycle !== state.cycle) return same("the Crown moved on to new scenarios while this was played", "stale");

  const scores = set.scores as number[];
  const reign = (): Reign => ({
    id: newReignId,
    holderId: challenge.challengerId,
    matchId: challenge.matchId,
    scores: [...scores],
    meanDelta: set.meanDelta ?? null,
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
      tally: null,
      ended: null,
      notice: null,
      reason: "the Crown was vacant",
    };
  }

  // Nobody can hold two open matches, so this cannot happen through the functions; it is
  // here so a hand-made row cannot make a holder defend against themselves.
  if (current.holderId === challenge.challengerId) return same("a holder cannot challenge their own Crown", "stale");

  const t = tally(scores, current.scores);
  const notice = (kind: NoticeKind, defences: number): Notice => ({
    playerId: current.holderId,
    kind,
    category: state.category,
    window: state.window,
    reignId: current.id,
    otherId: challenge.challengerId,
    defences,
    reignMs: now - current.startedAt,
    challengerRounds: t.won,
    holderRounds: t.lost,
  });

  if (t.won > t.lost) {
    const ended = { ...current, endedAt: now, endReason: "dethroned" as const, endedBy: challenge.challengerId };
    return {
      outcome: "took",
      state: { ...state, reign: reign() },
      judgedReignId: current.id,
      tally: t,
      ended,
      notice: notice("dethroned", current.defences),
      reason: "won more rounds than the holder",
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
    tally: t,
    ended: null,
    notice: notice("defended", defended.defences),
    reason: t.won === t.lost ? "level on rounds with the holder, and a tie is a defence" : "won fewer rounds than the holder",
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
      challengerRounds: null,
      holderRounds: null,
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
  notice: Pick<Notice, "kind" | "defences" | "reignMs" | "category"> & Partial<Pick<Notice, "challengerRounds" | "holderRounds">>,
  band: string | null | undefined,
  otherName: string | null,
): string {
  const crown = crownName(notice.category, band);
  const who = otherName || "another player";
  const rounds = notice.challengerRounds != null && notice.holderRounds != null
    ? `${notice.challengerRounds}–${notice.holderRounds}`
    : null;
  switch (notice.kind) {
    case "dethroned":
      return `You lost the ${crown} to ${who} ${defencePhrase(notice.defences)}${rounds ? `, ${rounds} on rounds` : ""}. You held it for ${duration(notice.reignMs)}.`;
    case "defended":
      return `${who} challenged your ${crown} and did not take it${rounds ? ` (${rounds} on rounds)` : ""}. Defences this reign: ${notice.defences}.`;
    case "lapsed":
      return `Your reign over the ${crown} reached its 7-day limit with ${notice.defences} defence${notice.defences === 1 ? "" : "s"}. It is vacant again, on three new scenarios.`;
    case "reset":
      return `The season no longer has your ${crown} scenarios, so the Crown was reset after ${duration(notice.reignMs)}. It is vacant again.`;
  }
}
