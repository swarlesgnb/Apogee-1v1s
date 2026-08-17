/**
 * Validate scenario selection, settlement and matchmaking.
 *
 * Where possible this runs against the real stats folder, because the properties that
 * matter (that baselines are sane, that deltas land in a believable range, that
 * matches are not systematically decided by one scenario) only show up against real
 * play. It finishes with a simulated season to confirm the ladder actually sorts
 * players by skill rather than by luck.
 *
 *   npx tsx src/core/match/validateMatch.ts [statsFolder]
 */

import { readFileSync } from "node:fs";

import { computeBaseline, scanStatsFolder } from "../history/history.ts";
import { defaultRating, updateRating, type Rating } from "../rating/glicko2.ts";
import { findOpponent, scoreCandidate, type StoredRunSet } from "./matchmaking.ts";
import {
  availableCategories,
  seededRandom,
  selectScenarios,
  type SelectableScenario,
} from "./scenarioSelection.ts";
import {
  explainVerdict,
  settleMatch,
  verdictToScore,
  type RoundSubmission,
} from "./settle.ts";

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

function round(tier: RoundSubmission["verificationTier"], score: number, baseline: number,
  scenarioId = 1, provisional = false): RoundSubmission {
  return {
    scenarioId,
    scenarioName: `scenario-${scenarioId}`,
    score,
    baseline,
    provisional,
    verificationTier: tier,
  };
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;

  // Build the scenario pool from the committed seed data.
  const bench = JSON.parse(
    readFileSync(new URL("../../../data/benchmarks/voltaic-s5.json", import.meta.url), "utf8"),
  ) as {
    difficulties: {
      name: string;
      categories: { name: string; scenarios: { name: string }[] }[];
    }[];
  };
  const subcats = (
    JSON.parse(
      readFileSync(new URL("../../../data/subcategories.json", import.meta.url), "utf8"),
    ) as { families: Record<string, { skill: string; subCategory: string }> }
  ).families;

  const difficulty = bench.difficulties.find((d) => d.name === "Intermediate")!;
  let nextId = 1;
  const pool: SelectableScenario[] = difficulty.categories.flatMap((cat) =>
    cat.scenarios.map((s) => {
      const family = s.name.replace(/^VT /, "").replace(/ Intermediate S5$/, "");
      const mapped = subcats[family];
      return {
        id: nextId++,
        name: s.name,
        aimType: mapped?.skill ?? cat.name,
        subCategory: mapped?.subCategory ?? null,
      };
    }),
  );

  console.log(`scenario pool : ${pool.length}\n`);

  // ---- scenario selection -----------------------------------------------------
  console.log("── scenario selection ───────────────────────────");

  const cats = availableCategories(pool);
  check("skills are discovered", cats.skills.length === 3, cats.skills.join(", "));
  check("nine sub-categories are discovered", cats.subCategories.length === 9,
    cats.subCategories.join(", "));

  const a = selectScenarios(pool, "match-abc", { category: "Clicking" });
  const b = selectScenarios(pool, "match-abc", { category: "Clicking" });
  check("selection is deterministic for a seed",
    JSON.stringify(a.map((s) => s.id)) === JSON.stringify(b.map((s) => s.id)));

  const c = selectScenarios(pool, "match-xyz", { category: "Clicking" });
  check("a different seed gives a different set",
    JSON.stringify(a.map((s) => s.id)) !== JSON.stringify(c.map((s) => s.id)));

  check("three scenarios are chosen", a.length === 3);
  check("all are in the requested category", a.every((s) => s.aimType === "Clicking"),
    a.map((s) => s.aimType).join(","));
  check("a skill queue does not repeat scenarios",
    new Set(a.map((s) => s.id)).size === 3);

  const sub = selectScenarios(pool, "match-sub", { category: "Static" });
  check("a sub-category queue still returns three", sub.length === 3);
  check("all are in the sub-category", sub.every((s) => s.subCategory === "Static"));

  const anyCat = selectScenarios(pool, "match-any", { category: "Any" });
  check("'Any' draws from the whole pool", anyCat.length === 3);

  const empty = selectScenarios(pool, "seed", { category: "Nonexistent" });
  check("an impossible category yields nothing", empty.length === 0);

  // Recently played scenarios should be deprioritised where the pool allows.
  const avoid = new Set(pool.filter((s) => s.aimType === "Clicking").slice(0, 3).map((s) => s.name));
  const fresh = selectScenarios(pool, "match-fresh", {
    category: "Clicking",
    playedRecently: avoid,
  });
  check("recently played scenarios are avoided when possible",
    fresh.every((s) => !avoid.has(s.name)), fresh.map((s) => s.name).join(", "));

  // The PRNG must be uniform enough not to bias scenario choice.
  const random = seededRandom("uniformity");
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100_000; i++) buckets[Math.floor(random() * 10)]++;
  const maxDeviation = Math.max(...buckets.map((n) => Math.abs(n - 10_000) / 10_000));
  check("the PRNG is close to uniform", maxDeviation < 0.05,
    `worst bucket off by ${(maxDeviation * 100).toFixed(1)}%`);

  // ---- settlement --------------------------------------------------------------
  console.log("\n── settlement ───────────────────────────────────");

  const clearWin = settleMatch({
    playerRounds: [round("verified", 110, 100, 1), round("verified", 220, 200, 2), round("verified", 330, 300, 3)],
    opponentRounds: [round("verified", 102, 100, 1), round("verified", 204, 200, 2), round("verified", 306, 300, 3)],
  });
  check("the better relative performance wins", clearWin.verdict === "win");
  check("match score is the mean delta",
    Math.abs((clearWin.player.matchScore ?? 0) - 0.1) < 1e-9,
    `${clearWin.player.matchScore}`);
  check("a clean match carries full rating weight", clearWin.ratingWeight === 1);

  // The defining property of this format, asserted rather than assumed.
  const outscoredButLost = settleMatch({
    playerRounds: [round("verified", 1000, 990, 1)],
    opponentRounds: [round("verified", 500, 400, 1)],
  });
  check("a higher raw score can still lose", outscoredButLost.verdict === "loss");
  check("the explanation names that case",
    explainVerdict(outscoredButLost).includes("raw points"),
    explainVerdict(outscoredButLost));

  const drawn = settleMatch({
    playerRounds: [round("verified", 110, 100, 1)],
    opponentRounds: [round("verified", 220, 200, 1)],
  });
  check("identical deltas draw", drawn.verdict === "draw");

  const rejectedRun = settleMatch({
    playerRounds: [round("rejected", 999, 100, 1), round("verified", 110, 100, 2)],
    opponentRounds: [round("verified", 105, 100, 1), round("verified", 105, 100, 2)],
  });
  check("a rejected run is excluded", rejectedRun.player.countedRounds === 1);
  check("mismatched round counts void the match", rejectedRun.verdict === "void",
    rejectedRun.voidReason);
  check("a void match cannot move rating", rejectedRun.ratingWeight === 0);

  const provisional = settleMatch({
    playerRounds: [round("verified", 110, 100, 1, true)],
    opponentRounds: [round("verified", 105, 100, 1)],
  });
  check("provisional baselines halve rating weight", provisional.ratingWeight === 0.5);

  const noBaseline = settleMatch({
    playerRounds: [round("verified", 110, 0, 1)],
    opponentRounds: [round("verified", 105, 100, 1)],
  });
  check("a zero baseline does not divide by zero",
    noBaseline.verdict === "void" && noBaseline.player.countedRounds === 0);

  // ---- a crash is an absent round, not a bad one ---------------------------------
  //
  // The case that motivates all of this: the player alt-F4s eight seconds into the one
  // attempt that counts. Scoring that would settle a complete match and hand them a
  // loss for a game that stopped working.
  const crashed = settleMatch({
    playerRounds: [
      { ...round("verified", 12, 100, 1), abandoned: true },
      round("verified", 110, 100, 2),
      round("verified", 108, 100, 3),
    ],
    opponentRounds: [
      round("verified", 105, 100, 1),
      round("verified", 105, 100, 2),
      round("verified", 105, 100, 3),
    ],
  });
  check("an abandoned round is not scored", crashed.player.countedRounds === 2);
  check("an abandoned round voids rather than loses", crashed.verdict === "void");
  check("a crash costs no rating", crashed.ratingWeight === 0);
  check("the void names the scenario, not a round count",
    /left before it finished/.test(crashed.voidReason ?? ""), crashed.voidReason);
  check("the abandoned round says why it was dropped",
    crashed.player.rounds[0].excludedReason === "left before the scenario finished");

  // Without the flag the same terrible score is simply a terrible score, and losing is
  // the correct outcome. The flag must be the only thing that changes it.
  const playedBadly = settleMatch({
    playerRounds: [
      round("verified", 12, 100, 1),
      round("verified", 110, 100, 2),
      round("verified", 108, 100, 3),
    ],
    opponentRounds: [
      round("verified", 105, 100, 1),
      round("verified", 105, 100, 2),
      round("verified", 105, 100, 3),
    ],
  });
  check("the same score unflagged is a loss, not a void", playedBadly.verdict === "loss",
    `${playedBadly.verdict}, ${playedBadly.player.countedRounds} rounds counted`);

  // ---- against real history ----------------------------------------------------
  console.log("\n── deltas from real play ────────────────────────");

  const history = scanStatsFolder(dir);
  if (history.size === 0) {
    check("real stats folder was readable", false, dir);
  } else {
    const deltas: number[] = [];
    for (const scenario of pool) {
      const h = history.get(scenario.name);
      if (!h || h.runs.length < 10) continue;
      const baseline = computeBaseline(h, h.best);
      // Score each real run against the baseline built from that same history.
      for (const run of h.runs.slice(-30)) {
        const d = (run.score - baseline.value) / baseline.value;
        if (Number.isFinite(d)) deltas.push(d);
      }
    }

    deltas.sort((x, y) => x - y);
    const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const p05 = deltas[Math.floor(deltas.length * 0.05)];
    const p95 = deltas[Math.floor(deltas.length * 0.95)];

    console.log(
      `  ${deltas.length} real deltas   mean ${(mean * 100).toFixed(1)}%   ` +
        `p05 ${(p05 * 100).toFixed(1)}%   p95 ${(p95 * 100).toFixed(1)}%`,
    );

    check("real deltas are centred near zero", Math.abs(mean) < 0.15,
      `mean ${(mean * 100).toFixed(1)}%`);
    check("deltas spread enough to separate players", p95 - p05 > 0.02,
      `range ${((p95 - p05) * 100).toFixed(1)}%`);
    check("deltas are not wildly unbounded", p95 < 0.5 && p05 > -0.6,
      `p05 ${(p05 * 100).toFixed(1)}%  p95 ${(p95 * 100).toFixed(1)}%`);
  }

  // ---- matchmaking -------------------------------------------------------------
  console.log("\n── matchmaking ──────────────────────────────────");

  const now = new Date("2026-08-16T12:00:00Z");
  const makeSet = (over: Partial<StoredRunSet> & { id: string }): StoredRunSet => ({
    playerId: `p-${over.id}`,
    displayName: over.id,
    category: "Clicking",
    difficulty: "Intermediate",
    scenarioIds: [1, 2, 3],
    deltas: [0.01, 0.02, 0.03],
    matchScore: 0.02,
    rating: defaultRating(),
    createdAt: now,
    provisional: false,
    ...over,
  });

  const me = { playerId: "me", rating: { rating: 1500, rd: 60, volatility: 0.06 },
    category: "Clicking", difficulty: "Intermediate", now };

  const poolSets = [
    makeSet({ id: "even", rating: { rating: 1505, rd: 60, volatility: 0.06 } }),
    makeSet({ id: "much-stronger", rating: { rating: 2100, rd: 60, volatility: 0.06 } }),
    makeSet({ id: "much-weaker", rating: { rating: 900, rd: 60, volatility: 0.06 } }),
  ];

  const found = findOpponent(me, poolSets);
  check("the closest-rated opponent is chosen", found.opponent?.id === "even",
    found.opponent?.id);
  check("the pairing is near even",
    Math.abs((found.candidate?.winProbability ?? 0) - 0.5) < 0.1,
    `${found.candidate?.winProbability.toFixed(3)}`);

  const ownOnly = findOpponent(me, [makeSet({ id: "mine", playerId: "me" })]);
  check("a player is never matched against themselves", ownOnly.opponent === null);

  const wrongCat = findOpponent(me, [makeSet({ id: "t", category: "Tracking" })]);
  check("a different category is not offered", wrongCat.opponent === null);

  const wrongDiff = findOpponent(me, [makeSet({ id: "d", difficulty: "Advanced" })]);
  check("a different difficulty is not offered", wrongDiff.opponent === null);

  check("an empty pool returns no opponent", findOpponent(me, []).opponent === null);

  const stale = scoreCandidate(me, makeSet({ id: "old", createdAt: new Date("2026-01-01") }));
  const recent = scoreCandidate(me, makeSet({ id: "new" }));
  check("older run sets are less preferred", stale.score > recent.score,
    `${stale.score.toFixed(1)} vs ${recent.score.toFixed(1)}`);

  const repeat = scoreCandidate(
    { ...me, recentOpponentIds: new Set(["p-even"]) },
    makeSet({ id: "even" }),
  );
  check("a recent opponent is penalised", repeat.score > recent.score);

  // ---- a simulated season ------------------------------------------------------
  console.log("\n── simulated season (does the ladder sort?) ─────");

  // 60 players with hidden true skill; the ladder should recover that ordering.
  const PLAYERS = 60;
  const PERIODS = 25;
  const MATCHES_PER_PERIOD = 4;

  const rng = seededRandom("season");
  const trueSkill = Array.from({ length: PLAYERS }, (_, i) => i / (PLAYERS - 1));
  const ratings: Rating[] = Array.from({ length: PLAYERS }, () => defaultRating());

  for (let period = 0; period < PERIODS; period++) {
    const games: { opponent: Rating; score: number }[][] =
      Array.from({ length: PLAYERS }, () => []);

    for (let p = 0; p < PLAYERS; p++) {
      for (let m = 0; m < MATCHES_PER_PERIOD; m++) {
        const o = Math.floor(rng() * PLAYERS);
        if (o === p) continue;

        // Performance = true skill plus noise, mirroring the delta spread measured
        // from real play. The better player usually wins, but not always.
        const perfP = trueSkill[p] + (rng() - 0.5) * 0.35;
        const perfO = trueSkill[o] + (rng() - 0.5) * 0.35;
        const scoreP = perfP > perfO ? 1 : 0;

        games[p].push({ opponent: ratings[o], score: scoreP });
        games[o].push({ opponent: ratings[p], score: 1 - scoreP });
      }
    }

    for (let p = 0; p < PLAYERS; p++) ratings[p] = updateRating(ratings[p], games[p]);
  }

  // Spearman rank correlation between true skill and final rating.
  const order = ratings
    .map((r, i) => ({ i, rating: r.rating }))
    .sort((x, y) => x.rating - y.rating);
  const rankOf = new Array(PLAYERS).fill(0);
  order.forEach((entry, rank) => { rankOf[entry.i] = rank; });

  let dSquared = 0;
  for (let i = 0; i < PLAYERS; i++) dSquared += Math.pow(i - rankOf[i], 2);
  const spearman = 1 - (6 * dSquared) / (PLAYERS * (PLAYERS * PLAYERS - 1));

  const spread = Math.max(...ratings.map((r) => r.rating)) -
    Math.min(...ratings.map((r) => r.rating));
  const meanRd = ratings.reduce((s, r) => s + r.rd, 0) / PLAYERS;

  console.log(
    `  ${PLAYERS} players, ${PERIODS} periods\n` +
      `  rank correlation with true skill : ${spearman.toFixed(3)}\n` +
      `  rating spread                    : ${spread.toFixed(0)}\n` +
      `  mean RD                          : ${meanRd.toFixed(1)}`,
  );

  check("the ladder recovers the true skill order", spearman > 0.85,
    `spearman ${spearman.toFixed(3)}`);
  check("ratings spread out meaningfully", spread > 400, `${spread.toFixed(0)}`);
  check("uncertainty settles", meanRd < 120, `${meanRd.toFixed(1)}`);

  // Verdict -> Glicko score plumbing.
  check("verdict maps to a Glicko score",
    verdictToScore("win") === 1 && verdictToScore("loss") === 0 &&
    verdictToScore("draw") === 0.5);

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: match pipeline validated");
}

main();
