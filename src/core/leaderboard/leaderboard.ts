/**
 * Who is where: the rating ladder, this week's movers, and the best score on a scenario.
 *
 * Pure, so the Edge Function that serves the boards (supabase/functions/leaderboard) and
 * the validator run the same code. Every input is a row the server already holds; nothing
 * here reads a clock of its own or decides who may see what - that is the function's job.
 *
 * Only people who have played are on any board. Signing in alone never lists anybody,
 * the same rule list-duels holds to: a board is a list of participants, not accounts.
 */

import { conservativeRating, type Rating } from "../rating/glicko2.ts";
import { PLACEMENT_MATCHES } from "../ranks/placement.ts";

// ---------------------------------------------------------------------------
// the ladder
// ---------------------------------------------------------------------------

export interface LadderInput {
  playerId: string;
  displayName: string;
  rating: Rating;
  matchesPlayed: number;
}

export interface LadderRow {
  /** 1-based. Null while placing, so a provisional rating never claims a position. */
  position: number | null;
  playerId: string;
  displayName: string;
  rating: number;
  rd: number;
  matchesPlayed: number;
  /** Matches still to play before a position is given. Zero once placed. */
  placementLeft: number;
}

/**
 * The ladder: placed players by conservative rating, then everybody still placing.
 *
 * Ordered by rating minus two deviations rather than by rating. A seeded or returning
 * player carries a wide RD, and sorting on the bare number would put somebody one lucky
 * match in above people who have proved their level over fifty. The rating itself is what
 * is shown, because it is the number the player knows.
 */
export function ladder(players: LadderInput[]): LadderRow[] {
  const played = players.filter((p) => p.matchesPlayed > 0);
  const byStrength = (a: LadderInput, b: LadderInput) =>
    conservativeRating(b.rating) - conservativeRating(a.rating) || a.displayName.localeCompare(b.displayName);

  const placed = played.filter((p) => p.matchesPlayed >= PLACEMENT_MATCHES).sort(byStrength);
  const placing = played.filter((p) => p.matchesPlayed < PLACEMENT_MATCHES).sort(byStrength);

  const row = (p: LadderInput, position: number | null): LadderRow => ({
    position,
    playerId: p.playerId,
    displayName: p.displayName,
    rating: Math.round(p.rating.rating),
    rd: Math.round(p.rating.rd),
    matchesPlayed: p.matchesPlayed,
    placementLeft: Math.max(0, PLACEMENT_MATCHES - p.matchesPlayed),
  });

  return [...placed.map((p, i) => row(p, i + 1)), ...placing.map((p) => row(p, null))];
}

// ---------------------------------------------------------------------------
// this week's movers
// ---------------------------------------------------------------------------

export interface HistoryInput {
  playerId: string;
  ratingBefore: number;
  ratingAfter: number;
  /** 1 win, 0 loss, 0.5 draw. */
  result: number;
  createdAt: string;
}

export interface MoverRow {
  playerId: string;
  displayName: string;
  matches: number;
  wins: number;
  /** Net rating change over the window, rounded. */
  change: number;
  /** Wins in a row ending at the player's latest match in the window. */
  streak: number;
}

export interface Movers {
  climbers: MoverRow[];
  winners: MoverRow[];
  streaks: MoverRow[];
}

/** One match is a coin flip, not a week. Fewer than this and a player is not a mover. */
export const MIN_MATCHES_TO_MOVE = 3;

/** How many rows each list shows. */
export const MOVERS_SHOWN = 10;

/**
 * The week's climbers, most wins and longest live streaks, from rating history.
 *
 * Rated matches only, because rating_history only holds those: seeding matches, voids
 * and tournament legs never moved a rating and so never appear. A streak counts the wins
 * at the end of the window and stops at the first loss or draw.
 */
export function movers(
  history: HistoryInput[],
  names: Map<string, string>,
  since: string,
): Movers {
  const cutoff = Date.parse(since);
  const byPlayer = new Map<string, HistoryInput[]>();
  for (const h of history) {
    if (Date.parse(h.createdAt) < cutoff) continue;
    byPlayer.set(h.playerId, [...(byPlayer.get(h.playerId) ?? []), h]);
  }

  const rows: MoverRow[] = [];
  for (const [playerId, games] of byPlayer) {
    const name = names.get(playerId);
    if (!name) continue;
    games.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    let streak = 0;
    for (let i = games.length - 1; i >= 0 && games[i].result === 1; i--) streak++;

    rows.push({
      playerId,
      displayName: name,
      matches: games.length,
      wins: games.filter((g) => g.result === 1).length,
      change: Math.round(games.reduce((s, g) => s + (g.ratingAfter - g.ratingBefore), 0)),
      streak,
    });
  }

  const eligible = rows.filter((r) => r.matches >= MIN_MATCHES_TO_MOVE);
  const tie = (a: MoverRow, b: MoverRow) => a.displayName.localeCompare(b.displayName);

  return {
    climbers: eligible.filter((r) => r.change > 0).sort((a, b) => b.change - a.change || tie(a, b)).slice(0, MOVERS_SHOWN),
    winners: eligible.filter((r) => r.wins > 0).sort((a, b) => b.wins - a.wins || b.change - a.change || tie(a, b)).slice(0, MOVERS_SHOWN),
    // A streak is a streak at any number of matches; two in a row is not one.
    streaks: rows.filter((r) => r.streak >= 2).sort((a, b) => b.streak - a.streak || tie(a, b)).slice(0, MOVERS_SHOWN),
  };
}

// ---------------------------------------------------------------------------
// a scenario's best scores
// ---------------------------------------------------------------------------

export interface ScoreInput {
  playerId: string;
  score: number;
  /** "verified" or "consistent"; the function never passes anything else. */
  tier: string;
  playedAt: string;
}

export interface ScoreRow {
  position: number;
  playerId: string;
  displayName: string;
  score: number;
  tier: string;
  playedAt: string;
}

/** How many players a scenario board shows. */
export const SCENARIO_SHOWN = 25;

/**
 * Each player's best run on one scenario, best first.
 *
 * One row per player, so the board says who is best rather than whose best ten runs are.
 * An equal score goes to whoever set it first, which is how a score board usually breaks
 * a tie and the one rule that cannot be gamed by replaying.
 *
 * The caller's own row is returned separately when it falls outside the shown rows, so a
 * player always sees where they stand and not only who is above them.
 */
export function scenarioBoard(
  runs: ScoreInput[],
  names: Map<string, string>,
  callerId: string | null,
): { rows: ScoreRow[]; you: ScoreRow | null; players: number } {
  const best = new Map<string, ScoreInput>();
  for (const r of runs) {
    if (!names.has(r.playerId) || !Number.isFinite(r.score)) continue;
    const held = best.get(r.playerId);
    if (!held || r.score > held.score || (r.score === held.score && r.playedAt < held.playedAt)) {
      best.set(r.playerId, r);
    }
  }

  const ordered = [...best.values()]
    .sort((a, b) => b.score - a.score || a.playedAt.localeCompare(b.playedAt))
    .map((r, i): ScoreRow => ({
      position: i + 1,
      playerId: r.playerId,
      displayName: names.get(r.playerId)!,
      score: r.score,
      tier: r.tier,
      playedAt: r.playedAt,
    }));

  const rows = ordered.slice(0, SCENARIO_SHOWN);
  const mine = callerId ? ordered.find((r) => r.playerId === callerId) ?? null : null;
  return { rows, you: mine && mine.position > SCENARIO_SHOWN ? mine : null, players: ordered.length };
}

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

/**
 * What the leaderboard function returns, imported by the function and the client both,
 * so a renamed field fails to compile on both sides rather than arriving undefined.
 */
export type LeaderboardPage =
  | { view: "ladder"; rows: LadderRow[]; you: LadderRow | null; players: number }
  | ({ view: "movers"; since: string } & Movers)
  | {
      view: "scenario";
      scenario: string;
      rows: ScoreRow[];
      you: ScoreRow | null;
      /** The caller's best when it fell outside the runs read; no position is claimed. */
      yourBest?: number | null;
      players: number;
    };

export type LeaderboardView = LeaderboardPage["view"];
