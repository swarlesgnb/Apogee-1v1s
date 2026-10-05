/**
 * Validate the boards: the ladder, the week's movers and a scenario's best scores.
 *
 * Each check names a property a player would notice if it broke - somebody who never
 * played appearing, one lucky match topping the ladder, a single player filling a
 * scenario board - and asserts it as something present, not merely absent.
 *
 *   npx tsx src/core/leaderboard/validateLeaderboard.ts
 */

import { PLACEMENT_MATCHES } from "../ranks/placement.ts";
import {
  ladder,
  MIN_MATCHES_TO_MOVE,
  movers,
  SCENARIO_SHOWN,
  scenarioBoard,
  type HistoryInput,
  type LadderInput,
  type ScoreInput,
} from "./leaderboard.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

// ---- the ladder -------------------------------------------------------------------
console.log("── ladder ───────────────────────────────────────");

const p = (id: string, rating: number, rd: number, matchesPlayed: number): LadderInput => ({
  playerId: id, displayName: id, rating: { rating, rd, volatility: 0.06 }, matchesPlayed,
});

const board = ladder([
  p("steady", 1700, 60, 40),
  p("lucky", 1850, 300, 12),
  p("never", 2000, 50, 0),
  p("newcomer", 1900, 200, 3),
  p("solid", 1600, 50, 30),
]);
const names = board.map((r) => r.playerId);

check("somebody who never played is not listed", !names.includes("never"), names.join(","));
check("a placed player with a tight rating outranks a higher one with a wide RD",
  names.indexOf("steady") < names.indexOf("lucky"), names.join(","));
check("placed players are numbered from 1", board[0].position === 1 && board[1].position === 2,
  board.map((r) => r.position).join(","));
check("a placing player has no position, however high the rating",
  board.find((r) => r.playerId === "newcomer")?.position === null);
check("placing players come after every placed one", names.at(-1) === "newcomer", names.join(","));
check("the matches left to place are counted",
  board.find((r) => r.playerId === "newcomer")?.placementLeft === PLACEMENT_MATCHES - 3);

// ---- this week's movers -----------------------------------------------------------
console.log("\n── movers ───────────────────────────────────────");

const since = "2026-10-01T00:00:00Z";
const game = (playerId: string, delta: number, result: number, day: number): HistoryInput => ({
  playerId, ratingBefore: 1500, ratingAfter: 1500 + delta, result,
  createdAt: `2026-10-0${day}T12:00:00Z`,
});
const history: HistoryInput[] = [
  // climber: +60 over four matches, ending on three wins
  game("climber", -10, 0, 1), game("climber", 20, 1, 2), game("climber", 25, 1, 3), game("climber", 25, 1, 4),
  // grinder: most wins, smaller net change
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((d, i) => game("grinder", i % 2 ? 8 : -2, i % 2 ? 1 : 0, d)),
  // one lucky match is not a week
  game("oneshot", 40, 1, 2),
  // last week's games do not count
  ...["2026-09-20", "2026-09-21", "2026-09-22"].map((d) => ({ ...game("stale", 50, 1, 1), createdAt: `${d}T12:00:00Z` })),
  // a streak that a loss broke at the end
  game("broken", 10, 1, 1), game("broken", 10, 1, 2), game("broken", -10, 0, 3),
  // somebody the server has no name for
  game("ghost", 30, 1, 1), game("ghost", 30, 1, 2), game("ghost", 30, 1, 3),
];
const moverNames = new Map(["climber", "grinder", "oneshot", "stale", "broken"].map((n) => [n, n]));
const week = movers(history, moverNames, since);

check("the top climber is the biggest net gain", week.climbers[0]?.playerId === "climber" && week.climbers[0].change === 60,
  JSON.stringify(week.climbers[0]));
check("the most wins can be somebody who climbed less", week.winners[0]?.playerId === "grinder",
  week.winners.map((r) => `${r.playerId}:${r.wins}`).join(","));
check(`fewer than ${MIN_MATCHES_TO_MOVE} matches is not a mover`,
  !week.climbers.some((r) => r.playerId === "oneshot") && !week.winners.some((r) => r.playerId === "oneshot"));
check("matches before the week do not count",
  ![...week.climbers, ...week.winners, ...week.streaks].some((r) => r.playerId === "stale"));
check("a streak is the wins at the end", week.streaks.find((r) => r.playerId === "climber")?.streak === 3,
  JSON.stringify(week.streaks));
check("a loss at the end means no streak", !week.streaks.some((r) => r.playerId === "broken"));
check("a player with no name is never listed",
  ![...week.climbers, ...week.winners, ...week.streaks].some((r) => r.playerId === "ghost"));

// ---- a scenario's best scores -----------------------------------------------------
console.log("\n── scenario board ───────────────────────────────");

const run = (playerId: string, score: number, playedAt: string, tier = "consistent"): ScoreInput =>
  ({ playerId, score, tier, playedAt });
const scoreNames = new Map(Array.from({ length: 40 }, (_, i) => [`p${i}`, `Player ${i}`]));
const runs: ScoreInput[] = [
  run("p0", 900, "2026-10-01"), run("p0", 950, "2026-10-02"), run("p0", 910, "2026-10-03"),
  run("p1", 950, "2026-10-01", "verified"),
  run("nobody", 9999, "2026-10-01"),
  ...Array.from({ length: 36 }, (_, i) => run(`p${i + 2}`, 800 - i, "2026-10-01")),
];
const scen = scenarioBoard(runs, scoreNames, "p37");

check("one row per player, their best", scen.rows.filter((r) => r.playerId === "p0").length === 1 &&
  scen.rows.find((r) => r.playerId === "p0")?.score === 950);
check("an equal score goes to whoever set it first", scen.rows[0].playerId === "p1",
  scen.rows.slice(0, 2).map((r) => `${r.playerId}:${r.score}@${r.playedAt}`).join(","));
check("a run from somebody with no name is not listed", !scen.rows.some((r) => r.playerId === "nobody"));
check(`the board shows ${SCENARIO_SHOWN}`, scen.rows.length === SCENARIO_SHOWN, String(scen.rows.length));
check("every player is counted, not only those shown", scen.players === 38, String(scen.players));
check("the caller below the board is told where they stand",
  scen.you?.playerId === "p37" && scen.you.position === 38, JSON.stringify(scen.you));
check("the caller on the board is not repeated below it", scenarioBoard(runs, scoreNames, "p0").you === null);
check("the tier travels with the score", scen.rows[0].tier === "verified");

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: leaderboards validated");
