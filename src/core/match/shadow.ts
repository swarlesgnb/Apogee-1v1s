/**
 * Shadows: the opponent a ranked match gets when nobody else is in the pool.
 *
 * WHAT A SHADOW IS, UNDER RANKED V2
 *
 * Ranked is decided on raw score, round by round, best of three (PLAN.md §3). So a Shadow
 * is a score on each of the match's three scenarios: the score at a stated percentile of
 * that scenario's board, the same percentile on all three. "A 58th-percentile score on
 * each" means: on every one of these scenarios, 58% of the board scores below the
 * Shadow. The match against it is decided exactly as a ranked match is, by the same
 * settleMatch in rounds format.
 *
 * WHERE THE SCORES COME FROM
 *
 * From the numbers Season 1 already commits for its ranks, and nothing else
 * (src/core/match/shadowSource.ts builds the table, `npm run build:shadows`). Every
 * scenario's rank thresholds are scores read off its board at the pool ladder's
 * percentiles (data/pool.json), and data/season-1/families.json records the same board's
 * median. Between two of those points the score is interpolated the way the season reads
 * every board (scoreAtTopFraction). Outside them there is no committed number, and a Shadow
 * does not invent one: that round is not contested (see judgeShadow).
 *
 * WHAT IT DECIDES
 *
 *   rating      nothing. Ranked v2 rates the caller against a person's rating at play,
 *               and a Shadow has none. Moving Glicko-2 against a table would also be a
 *               rating anybody could farm.
 *   the pool    nothing new. The side is stored as every seeding side is, and its rounds
 *               join the bank the next player draws from.
 *   a read-out  the Shadow ladder: the highest percentile beaten so far.
 *
 * DETERMINISM
 *
 * Which Shadow a player meets is a pure function of server data: their Shadow history
 * (which rung, how many they have met) and the table. The ordinal advances only when a
 * Shadow match ends, and ending one by abandoning it counts as a loss, so requeueing
 * cannot reroll it.
 */

import { seededRandom } from "./scenarioSelection.ts";
import { settleMatch, type RoundResult, type RoundSubmission } from "./settle.ts";

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

/** One scenario's committed board points: [percentile from the bottom, score], rising. */
export interface ShadowScenario {
  window: number;
  points: [number, number][];
}

export interface ShadowScoreTable {
  version: number;
  /** The season's own builtAt, so a rebuild from the same files is byte-identical. */
  builtAt: string;
  season: string;
  scenarios: Record<string, ShadowScenario>;
  /** Where every number came from. Read by the validator and the doc, never by players. */
  sources: Record<string, string>;
}

/**
 * The score at percentile p on one scenario, or null when nothing committed covers p.
 *
 * Linear in score against percentile between the two committed points around p, which is
 * scoreAtTopFraction's rule (src/core/season/percentiles.ts) written for percentiles from
 * the bottom. No clamping at the ends: a percentile below the lowest committed point or
 * above the highest has no number, and saying the nearest one would be inventing it.
 */
export function shadowScoreAt(table: ShadowScoreTable, scenario: string, p: number): number | null {
  const points = table.scenarios[scenario]?.points;
  if (!points || points.length === 0) return null;
  if (p < points[0][0] || p > points[points.length - 1][0]) return null;
  for (let i = 0; i < points.length; i++) {
    const [pi, si] = points[i];
    if (p === pi) return si;
    const next = points[i + 1];
    if (next && p < next[0]) {
      const t = (p - pi) / (next[0] - pi);
      // One decimal, the precision KovaaK's shows a score at, so a Shadow score on screen is
      // the number the round was decided against.
      return Math.round((si + t * (next[1] - si)) * 10) / 10;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// the ladder
// ---------------------------------------------------------------------------

/**
 * Percentile centres of the Shadow ladder, easiest first.
 *
 * Seven rungs, one up for a win and one down for a loss: the staircase that converges on
 * the level a player beats half the time, so every Shadow match stays a contest.
 *
 * Why 52 to 92 and not wider. Every centre, with its jitter, sits inside what Season 1
 * commits for the match window's scenarios: their median (the 50th) and their rank
 * thresholds, which for Intermediate are read at the 74th to 94.5th percentiles. Below the
 * median nothing is committed for those scenarios, so a lower rung would have no score.
 * The first Shadow is the bottom rung, a median score, which is the opener a typical player
 * on these boards wins about as often as they lose.
 */
export const SHADOW_RUNGS = [52, 58, 65, 72, 79, 86, 92] as const;
export const SHADOW_START_RUNG = 0;

/** Spread around a rung's centre, so consecutive Shadows on a rung are not the same number. */
export const SHADOW_JITTER = 2;

export type ShadowResult = "win" | "loss" | "draw" | "void" | "forfeit";

export interface ShadowRecord {
  ordinal: number;
  percentile: number;
  /** Null while the match is still open. */
  result: ShadowResult | null;
  /** Rounds won, lost and tied against the Shadow, once decided. */
  won?: number | null;
  lost?: number | null;
  tied?: number | null;
  decidedAt?: string | null;
}

/** How a result moves the ladder. Forfeit is a loss: otherwise abandoning would be the free way out. */
export function rungStep(result: ShadowResult | null): -1 | 0 | 1 {
  if (result === "win") return 1;
  if (result === "loss" || result === "forfeit") return -1;
  return 0;
}

/** The rung the next Shadow is fielded on, replaying every decided result in order. */
export function ladderRung(records: ShadowRecord[]): number {
  let rung = SHADOW_START_RUNG;
  for (const r of [...records].sort((a, b) => a.ordinal - b.ordinal)) {
    rung = Math.min(SHADOW_RUNGS.length - 1, Math.max(0, rung + rungStep(r.result)));
  }
  return rung;
}

/** The next ordinal: one past the highest a player has been fielded. */
export function nextOrdinal(records: ShadowRecord[]): number {
  return records.reduce((max, r) => Math.max(max, r.ordinal + 1), 0);
}

export function shadowSeed(playerId: string, ordinal: number): string {
  return `shadow:${playerId}:${ordinal}`;
}

/** The percentile fielded on a rung: its centre, plus or minus the jitter, from the seed. */
export function drawPercentile(rung: number, seed: string): number {
  const centre = SHADOW_RUNGS[Math.min(SHADOW_RUNGS.length - 1, Math.max(0, rung))];
  const offset = Math.floor(seededRandom(seed)() * (2 * SHADOW_JITTER + 1)) - SHADOW_JITTER;
  return centre + offset;
}

export interface ShadowPlan {
  ordinal: number;
  rung: number;
  percentile: number;
  /** The Shadow's score on each scenario, in match order; null where nothing is committed. */
  scores: (number | null)[];
  tableVersion: number;
}

/** Everything a Shadow match freezes at creation. */
export function planShadow(table: ShadowScoreTable, playerId: string, records: ShadowRecord[], scenarioNames: string[]): ShadowPlan {
  const ordinal = nextOrdinal(records);
  const rung = ladderRung(records);
  const percentile = drawPercentile(rung, shadowSeed(playerId, ordinal));
  return {
    ordinal,
    rung,
    percentile,
    scores: scenarioNames.map((name) => shadowScoreAt(table, name, percentile)),
    tableVersion: table.version,
  };
}

// ---------------------------------------------------------------------------
// judging a Shadow match
// ---------------------------------------------------------------------------

/** One round against a Shadow. "no-score": nothing committed covers the percentile there. */
export type ShadowRoundResult = RoundResult | "no-score" | "excluded";

export interface ShadowJudgement {
  verdict: "win" | "loss" | "draw" | "void";
  voidReason: string | null;
  /** Rounds the Shadow had a score on, and so contested. */
  contested: number;
  tally: { won: number; lost: number; tied: number };
  rounds: ShadowRoundResult[];
}

/**
 * Decide a Shadow match with the same settleMatch, in rounds format, that decides ranked.
 *
 * Only the rounds the Shadow has a committed score on are passed in: the Shadow becomes an
 * opponent whose rounds are those scores. A round with no committed score is neither won
 * nor lost, and says so. A rejected run or a round left early voids the match exactly as
 * it would against a person, because settleMatch is the one deciding.
 */
export function judgeShadow(playerRounds: RoundSubmission[], shadowScores: (number | null)[]): ShadowJudgement {
  const covered = playerRounds.map((_, i) => shadowScores[i] != null);
  const mine = playerRounds.filter((_, i) => covered[i]);
  const shadow: RoundSubmission[] = mine.map((r) => {
    const score = shadowScores[playerRounds.indexOf(r)] as number;
    return { scenarioId: r.scenarioId, scenarioName: r.scenarioName, score, baseline: score, provisional: false, verificationTier: "consistent" };
  });
  const none = { won: 0, lost: 0, tied: 0 };
  if (mine.length === 0) {
    return {
      verdict: "void", voidReason: "none of these scenarios has a committed score at that percentile",
      contested: 0, tally: none, rounds: playerRounds.map(() => "no-score"),
    };
  }
  const s = settleMatch({ playerRounds: mine, opponentRounds: shadow, format: "rounds" });
  const results = s.roundResults ?? [];
  let k = 0;
  let j = 0;
  const rounds: ShadowRoundResult[] = playerRounds.map((_, i) => {
    if (!covered[i]) return "no-score";
    const counted = s.player.rounds[j++]?.counted;
    if (s.verdict === "void" || !counted) return "excluded";
    return results[k++] ?? "excluded";
  });
  return {
    verdict: s.verdict,
    voidReason: s.voidReason ?? null,
    contested: mine.length,
    tally: s.verdict === "void" ? none : {
      won: results.filter((r) => r === "won").length,
      lost: results.filter((r) => r === "lost").length,
      tied: results.filter((r) => r === "tied").length,
    },
    rounds,
  };
}

// ---------------------------------------------------------------------------
// words
// ---------------------------------------------------------------------------

export function ordinalSuffix(n: number): string {
  const v = Math.round(n);
  const teen = v % 100;
  if (teen >= 11 && teen <= 13) return `${v}th`;
  return `${v}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[v % 10] ?? "th"}`;
}

/** "a 58th-percentile score on each", "an 86th-percentile score on each". */
export function shadowLabel(percentile: number): string {
  const word = ordinalSuffix(percentile);
  return `${/^(8|11th|18th)/.test(word) ? "an" : "a"} ${word}-percentile score on each`;
}

/** "2–1" or "1–1, 1 tied". */
export function tallyText(t: { won: number; lost: number; tied: number }): string {
  return `${t.won}–${t.lost}${t.tied > 0 ? `, ${t.tied} tied` : ""}`;
}

/** The line under a Shadow verdict: the rounds, the reason, and that nothing was rated. */
export function explainShadow(j: ShadowJudgement, percentile: number, rounds: number): string {
  const label = shadowLabel(percentile);
  if (j.verdict === "void") {
    return `No result against the Shadow: ${j.voidReason ?? "the match could not be settled"}. Shadows move no rating.`;
  }
  const head = j.verdict === "win"
    ? `You beat the Shadow ${tallyText(j.tally)} on rounds: ${label}.`
    : j.verdict === "loss"
      ? `The Shadow took it ${tallyText({ won: j.tally.lost, lost: j.tally.won, tied: j.tally.tied })} on rounds: ${label}.`
      : `Level with the Shadow, ${tallyText(j.tally)} on rounds: ${label}.`;
  const missing = rounds - j.contested;
  const gap = missing > 0
    ? ` ${missing === 1 ? "One scenario has" : `${missing} scenarios have`} no committed score at that percentile, so ` +
      `${missing === 1 ? "it was" : "they were"} not contested and the other ${["", "one", "two", "three", "four"][j.contested] ?? j.contested} decided it.`
    : "";
  return `${head}${gap} Shadows move no rating.`;
}

// ---------------------------------------------------------------------------
// the read-out
// ---------------------------------------------------------------------------

/** How far up the ladder a player has got, from their decided results. No model behind it. */
export interface ShadowStanding {
  /** Highest percentile beaten, among results decided. */
  highestBeaten: number | null;
  /** Lowest percentile lost to above that, if any: the bracket a player sits in. */
  lostAbove: number | null;
  roundsWon: number;
  roundsContested: number;
  streak: number;
  played: number;
}

export function shadowStanding(records: ShadowRecord[]): ShadowStanding {
  const decided = records.filter((r) => r.result && r.result !== "void");
  const wins = decided.filter((r) => r.result === "win").map((r) => r.percentile);
  const highestBeaten = wins.length ? Math.max(...wins) : null;
  const above = decided
    .filter((r) => (r.result === "loss" || r.result === "forfeit") && r.percentile > (highestBeaten ?? -1))
    .map((r) => r.percentile);
  let roundsWon = 0;
  let roundsContested = 0;
  for (const r of decided) {
    if (r.won == null) continue;
    roundsWon += r.won;
    roundsContested += r.won + (r.lost ?? 0) + (r.tied ?? 0);
  }
  return {
    highestBeaten,
    lostAbove: above.length ? Math.min(...above) : null,
    roundsWon,
    roundsContested,
    streak: shadowStreak(records),
    played: decided.length,
  };
}

/** Consecutive Shadow wins, newest first. A void neither extends nor breaks it. */
export function shadowStreak(records: ShadowRecord[]): number {
  let streak = 0;
  for (const r of [...records].sort((a, b) => b.ordinal - a.ordinal)) {
    if (r.result === null || r.result === "void") continue;
    if (r.result !== "win") break;
    streak++;
  }
  return streak;
}
