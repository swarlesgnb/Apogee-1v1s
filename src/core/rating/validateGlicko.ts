/**
 * Validate the Glicko-2 implementation.
 *
 * The decisive test is Glickman's own worked example from the specification: a player
 * at 1500/200 playing three opponents with known outcomes must land on specific
 * published values. Any implementation that misses these has the volatility iteration
 * subtly wrong, which is the classic failure mode.
 *
 *   npx tsx src/core/rating/validateGlicko.ts
 */

import {
  conservativeRating,
  defaultRating,
  updateRating,
  winProbability,
  type GameResult,
  type Rating,
} from "./glicko2.ts";
import { seasonStanding, seedRating, type StandingScenario } from "./seed.ts";
import { readFileSync } from "node:fs";
import { scanStatsFolder } from "../history/history.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function close(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

console.log("── Glickman's reference example ─────────────────");

// From the Glicko-2 specification: player 1500/200/0.06, tau = 0.5.
const player: Rating = { rating: 1500, rd: 200, volatility: 0.06 };
const games: GameResult[] = [
  { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 },
  { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 },
  { opponent: { rating: 1700, rd: 300, volatility: 0.06 }, score: 0 },
];

const updated = updateRating(player, games, 0.5);

console.log(
  `  rating     ${updated.rating.toFixed(4)}  (expected 1464.0506)\n` +
    `  rd         ${updated.rd.toFixed(4)}  (expected  151.5165)\n` +
    `  volatility ${updated.volatility.toFixed(6)}  (expected 0.059996)\n`,
);

check("rating matches the published value", close(updated.rating, 1464.0506, 0.001),
  `${updated.rating}`);
check("rd matches the published value", close(updated.rd, 151.5165, 0.001),
  `${updated.rd}`);
check("volatility matches the published value",
  close(updated.volatility, 0.059996, 0.000001), `${updated.volatility}`);

console.log("\n── behaviour ────────────────────────────────────");

// An inactive period must widen RD - that is what lets a returning player move again.
const idle = updateRating({ rating: 1500, rd: 100, volatility: 0.06 }, []);
check("inactivity widens RD", idle.rd > 100, `${idle.rd.toFixed(2)}`);
check("inactivity leaves the rating alone", close(idle.rating, 1500, 1e-9));

// Beating a stronger opponent must gain more than beating a weaker one.
const base: Rating = { rating: 1500, rd: 80, volatility: 0.06 };
const beatStrong = updateRating(base, [
  { opponent: { rating: 1800, rd: 80, volatility: 0.06 }, score: 1 },
]);
const beatWeak = updateRating(base, [
  { opponent: { rating: 1200, rd: 80, volatility: 0.06 }, score: 1 },
]);
check(
  "beating a stronger opponent gains more",
  beatStrong.rating - base.rating > beatWeak.rating - base.rating,
  `${(beatStrong.rating - base.rating).toFixed(1)} vs ${(beatWeak.rating - base.rating).toFixed(1)}`,
);

// Losing to a weaker opponent must cost more than losing to a stronger one.
const loseWeak = updateRating(base, [
  { opponent: { rating: 1200, rd: 80, volatility: 0.06 }, score: 0 },
]);
const loseStrong = updateRating(base, [
  { opponent: { rating: 1800, rd: 80, volatility: 0.06 }, score: 0 },
]);
check(
  "losing to a weaker opponent costs more",
  base.rating - loseWeak.rating > base.rating - loseStrong.rating,
  `${(base.rating - loseWeak.rating).toFixed(1)} vs ${(base.rating - loseStrong.rating).toFixed(1)}`,
);

// Playing reduces uncertainty.
const played = updateRating(defaultRating(), [
  { opponent: { rating: 1500, rd: 100, volatility: 0.06 }, score: 1 },
]);
check("playing narrows RD", played.rd < defaultRating().rd,
  `${played.rd.toFixed(1)} from ${defaultRating().rd}`);

// A draw against an equal opponent should barely move the rating.
const drew = updateRating(base, [
  { opponent: { rating: 1500, rd: 80, volatility: 0.06 }, score: 0.5 },
]);
check("a draw with an equal opponent is near-neutral",
  close(drew.rating, 1500, 1), `${drew.rating.toFixed(2)}`);

console.log("\n── convergence over a season ────────────────────");

// A player whose true strength is well above 1500 should climb there and settle.
// Deterministic outcome by strength, so the test cannot flake.
let climber = defaultRating();
const field: Rating[] = [
  { rating: 1400, rd: 60, volatility: 0.06 },
  { rating: 1500, rd: 60, volatility: 0.06 },
  { rating: 1600, rd: 60, volatility: 0.06 },
];
for (let period = 0; period < 30; period++) {
  climber = updateRating(
    climber,
    field.map((opponent) => ({ opponent, score: 1 })),
  );
}
check("a consistently winning player climbs", climber.rating > 1800,
  `${climber.rating.toFixed(0)}`);
// RD settles well below the 350 starting point but does not collapse: a player who
// wins every match against a fixed field learns little from each result, so the
// uncertainty floors out rather than tending to zero. That is correct Glicko-2
// behaviour, not a convergence failure.
check("their RD converges and stays bounded", climber.rd < 100 && climber.rd > 20,
  `${climber.rd.toFixed(1)}`);

console.log("\n── duel farming does not pay ────────────────────");

// Duels let a player choose their opponent, which no queued match does, so "pick weak
// opponents and grind" is the obvious exploit to look for. There is no rule against it
// because the arithmetic already refuses, and FAIR-PLAY.md prints this table as the
// reason - so it is derived here rather than asserted there. If these numbers move, the
// document is wrong and this fails.
const farmer: Rating = { rating: 1800, rd: 60, volatility: 0.06 };
const settled = (rating: number): Rating => ({ rating, rd: 60, volatility: 0.06 });

console.log("    opponent   win      loss     losing costs");
let lastGain = Infinity;
let monotonic = true;
for (const opponent of [1800, 1600, 1400, 1200, 1000, 800]) {
  const gain = updateRating(farmer, [{ opponent: settled(opponent), score: 1 }]).rating - farmer.rating;
  const cost = farmer.rating - updateRating(farmer, [{ opponent: settled(opponent), score: 0 }]).rating;
  if (gain >= lastGain) monotonic = false;
  lastGain = gain;
  console.log(
    `    ${String(opponent).padEnd(10)} ${("+" + gain.toFixed(2)).padStart(7)}` +
      `  ${("-" + cost.toFixed(2)).padStart(7)}  ${(cost / gain).toFixed(1)}x`,
  );
}
check("beating a weaker opponent pays less the weaker they are", monotonic);

// The two figures FAIR-PLAY.md quotes in prose, so the sentence cannot drift from the
// table above it.
const gain400 = updateRating(farmer, [{ opponent: settled(1400), score: 1 }]).rating - farmer.rating;
const cost400 = farmer.rating - updateRating(farmer, [{ opponent: settled(1400), score: 0 }]).rating;
check("400 points down, a win is worth under two points",
  gain400 < 2, `${gain400.toFixed(2)}`);
check("and the upset loss still costs nearly a full one",
  cost400 > 18, `${cost400.toFixed(2)}`);
check("so losing costs at least 9x the win at that gap",
  cost400 / gain400 > 9, `${(cost400 / gain400).toFixed(1)}x`);

console.log("\n── helpers ──────────────────────────────────────");

const even = winProbability(base, base);
check("equal players are a coin flip", close(even, 0.5, 1e-9), `${even}`);

const favoured = winProbability({ rating: 1800, rd: 50, volatility: 0.06 }, base);
check("a stronger player is favoured", favoured > 0.7, `${favoured.toFixed(3)}`);

const uncertain = winProbability(
  { rating: 1800, rd: 350, volatility: 0.06 },
  { rating: 1500, rd: 350, volatility: 0.06 },
);
check("high uncertainty pulls the odds toward even", uncertain < favoured,
  `${uncertain.toFixed(3)} vs ${favoured.toFixed(3)}`);

check("conservative rating discounts uncertainty",
  conservativeRating(defaultRating()) === 1500 - 700);

// ---- seeding a first rating -------------------------------------------------------
console.log("\n── seeded first ratings ─────────────────────────");

// Two windows of four ranks, three families, each with a variant in both windows.
const ladder: StandingScenario[] = ["a", "b", "c"].flatMap((family, f) => [
  { scenarioId: f * 10 + 1, family, windowIndex: 0, rankMaxes: [100, 200, 300, 400] },
  { scenarioId: f * 10 + 2, family, windowIndex: 1, rankMaxes: [1000, 2000, 3000, 4000] },
]);
const pbs = (entries: [number, number][]) => new Map(entries);

check("too few families gives no standing",
  seasonStanding(ladder, pbs([[1, 400], [11, 400]]), 4) === null);

const top = seasonStanding(ladder, pbs([[2, 4000], [12, 4000], [22, 4000]]), 4);
check("the top threshold everywhere is a standing of 1", close(top?.standing ?? -1, 1, 1e-9), `${top?.standing}`);

const lowWindow = seasonStanding(ladder, pbs([[1, 400], [11, 400], [21, 400]]), 4);
check("the top of window 0 is halfway up two windows", close(lowWindow?.standing ?? -1, 0.5, 1e-9),
  `${lowWindow?.standing}`);

// A variant above window 0 proves nothing below its own first threshold, exactly as the
// grading engine treats it, so a poor score on the harder variant cannot outrank a good
// one on the easier.
const silent = seasonStanding(ladder, pbs([[1, 400], [2, 500], [11, 400], [21, 400]]), 4);
check("a harder variant below its first threshold does not count",
  close(silent?.standing ?? -1, 0.5, 1e-9), `${silent?.standing}`);

const best = seasonStanding(ladder, pbs([[1, 100], [2, 2000], [11, 400], [21, 400]]), 4);
check("a family takes the best of its variants", (best?.standing ?? 0) > 0.5, `${best?.standing}`);

check("no standing seeds the default", seedRating(null).rating === 1500 && seedRating(null).rd === 350);
check("a standing seeds a more certain rating than a blank account", seedRating(0.5).rd < defaultRating().rd);
check("a stronger standing seeds higher", seedRating(0.8).rating > seedRating(0.3).rating);
check("the middle of the ladder seeds the default rating", close(seedRating(0.5).rating, 1500, 1e-9));

// Against the season that ships and the history on this machine: local bests stand in
// for verified PBs, which this script cannot reach. A presence check, so a season or
// engine change that silently stopped producing standings fails here.
const seasonFile = JSON.parse(
  readFileSync(new URL("../../../data/seasons/season-1.json", import.meta.url), "utf8"),
) as { windowSize: number; scenarios: { scenario: string; family: string; window: number; rankMaxes: number[] }[] };
const history = scanStatsFolder(process.argv[2] ?? DEFAULT_STATS_DIR);
const seasonLadder = seasonFile.scenarios.map((s, i) => ({
  scenarioId: i, family: s.family, windowIndex: s.window, rankMaxes: s.rankMaxes,
}));
const localBests = new Map<number, number>();
seasonFile.scenarios.forEach((s, i) => {
  const h = history.get(s.scenario);
  if (h && h.best > 0) localBests.set(i, h.best);
});
const real = seasonStanding(seasonLadder, localBests, seasonFile.windowSize);
console.log(`  this machine: ${localBests.size} season scenarios played, ` +
  (real ? `standing ${real.standing.toFixed(3)} over ${real.families} families, seed ${seedRating(real.standing).rating.toFixed(0)}` : "no standing"));
check("the shipped season yields a standing from real history",
  real !== null && real.standing > 0 && real.standing <= 1, real ? real.standing.toFixed(3) : "none");

console.log();
if (failures > 0) {
  console.error(`FAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("OK: Glicko-2 matches the specification");
