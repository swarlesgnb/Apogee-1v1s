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
import {
  findOpponent,
  offerableRounds,
  scoreCandidate,
  shouldPlantFresh,
  type BankRound,
  type MatchmakingCriteria,
  type OpponentBank,
} from "./matchmaking.ts";
import {
  availableCategories,
  seededRandom,
  selectScenarios,
  type SelectableScenario,
} from "./scenarioSelection.ts";
import {
  eligibilityMessage,
  MIN_RUNS_TO_QUEUE,
  queueEligibility,
} from "./eligibility.ts";
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

  // ---- rounds: what ranked is settled on -------------------------------------------
  console.log("\n── settlement: rounds ───────────────────────────");

  const rounds = (mine: number[], theirs: number[]) => settleMatch({
    format: "rounds",
    playerRounds: mine.map((s, i) => round("verified", s, 100, i + 1)),
    opponentRounds: theirs.map((s, i) => round("verified", s, 100, i + 1)),
  });

  const twoOne = rounds([110, 90, 105], [100, 100, 100]);
  check("two rounds of three win", twoOne.verdict === "win");
  check("the tally is per round", JSON.stringify(twoOne.roundResults) === '["won","lost","won"]',
    JSON.stringify(twoOne.roundResults));
  check("the explanation states the tally", explainVerdict(twoOne).includes("2–1"), explainVerdict(twoOne));
  check("three of three win", rounds([101, 101, 101], [100, 100, 100]).verdict === "win");
  check("one round of three loses", rounds([110, 90, 90], [100, 100, 100]).verdict === "loss");

  // A blowout on one scenario is one round, not the match. This is the property the
  // format exists for, so it is asserted directly.
  const blowout = rounds([500, 99, 99], [100, 100, 100]);
  check("a blowout on one scenario does not carry the other two", blowout.verdict === "loss");

  check("a tied round counts for nobody", rounds([110, 90, 100], [100, 100, 100]).verdict === "draw");
  check("one round won and two tied is a win", rounds([110, 100, 100], [100, 100, 100]).verdict === "win");

  // Scoring above your own usual decides nothing here; only the raw scores do.
  const sharper = settleMatch({
    format: "rounds",
    playerRounds: [round("verified", 900, 800, 1), round("verified", 900, 800, 2), round("verified", 900, 800, 3)],
    opponentRounds: [round("verified", 950, 1000, 1), round("verified", 950, 1000, 2), round("verified", 950, 1000, 3)],
  });
  check("beating your baseline does not beat a higher score", sharper.verdict === "loss");

  const provisionalRounds = settleMatch({
    format: "rounds",
    playerRounds: [round("verified", 110, 100, 1, true)],
    opponentRounds: [round("verified", 105, 100, 1)],
  });
  check("a provisional baseline does not reduce weight in rounds", provisionalRounds.ratingWeight === 1);

  const zeroBaseline = settleMatch({
    format: "rounds",
    playerRounds: [round("verified", 110, 0, 1), round("verified", 110, 100, 2), round("verified", 110, 100, 3)],
    opponentRounds: [round("verified", 100, 100, 1), round("verified", 100, 100, 2), round("verified", 100, 100, 3)],
  });
  check("a missing baseline still counts the round in rounds",
    zeroBaseline.verdict === "win" && zeroBaseline.player.rounds[0].counted && zeroBaseline.player.rounds[0].delta === null);

  const misaligned = settleMatch({
    format: "rounds",
    playerRounds: [round("rejected", 110, 100, 1), round("verified", 110, 100, 2), round("verified", 110, 100, 3)],
    opponentRounds: [round("verified", 100, 100, 1), round("rejected", 100, 100, 2), round("verified", 100, 100, 3)],
  });
  check("sides that counted different scenarios void", misaligned.verdict === "void" && misaligned.ratingWeight === 0,
    misaligned.voidReason);

  const crashedRounds = settleMatch({
    format: "rounds",
    playerRounds: [{ ...round("verified", 12, 100, 1), abandoned: true }, round("verified", 110, 100, 2), round("verified", 110, 100, 3)],
    opponentRounds: [round("verified", 100, 100, 1), round("verified", 100, 100, 2), round("verified", 100, 100, 3)],
  });
  check("a crash still voids rather than loses in rounds", crashedRounds.verdict === "void");

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

  // A window of its own: eight Clicking scenarios over two sub-skills and four Tracking.
  const window: SelectableScenario[] = [
    ...[1, 2, 3, 4].map((id) => ({ id, name: `click-${id}`, aimType: "Clicking", subCategory: "Static" })),
    ...[5, 6, 7, 8].map((id) => ({ id, name: `click-${id}`, aimType: "Clicking", subCategory: "Dynamic" })),
    ...[9, 10, 11, 12].map((id) => ({ id, name: `track-${id}`, aimType: "Tracking", subCategory: "Precise" })),
  ];

  const at = (r: number) => ({ rating: r, rd: 60, volatility: 0.06 });

  // One round per scenario, all from one sitting unless overridden.
  const bankRound = (owner: string, scenarioId: number, over: Partial<BankRound> = {}): BankRound => ({
    runId: `${owner}-run-${scenarioId}`,
    scenarioId,
    score: 1000,
    delta: 0.01,
    provisional: false,
    difficulty: "Intermediate",
    playedAt: now,
    sideId: `${owner}@side`,
    ...over,
  });
  const makeBank = (id: string, scenarioIds = [1, 2, 3, 4, 5, 6], over: Partial<OpponentBank> = {}): OpponentBank => ({
    playerId: id,
    displayName: id,
    rating: defaultRating(),
    rounds: scenarioIds.map((s) => bankRound(id, s)),
    ...over,
  });

  const me: MatchmakingCriteria = {
    playerId: "me", rating: at(1500), category: "Clicking", difficulty: "Intermediate",
    pool: window, seed: "match-1", now,
  };

  const found = findOpponent(me, [
    makeBank("even", undefined, { rating: at(1505) }),
    makeBank("much-stronger", undefined, { rating: at(2100) }),
    makeBank("much-weaker", undefined, { rating: at(900) }),
  ]);
  check("the closest-rated opponent is chosen", found.opponent?.playerId === "even",
    found.opponent?.playerId);
  check("the pairing is near even",
    Math.abs((found.candidate?.winProbability ?? 0) - 0.5) < 0.1,
    `${found.candidate?.winProbability.toFixed(3)}`);
  check("a match is three distinct scenarios",
    new Set(found.candidate?.rounds.map((r) => r.scenarioId)).size === 3);

  const again = findOpponent(me, [makeBank("even", undefined, { rating: at(1505) })]);
  check("the draw is reproducible from the seed",
    JSON.stringify(again.candidate?.rounds.map((r) => r.runId)) ===
      JSON.stringify(found.candidate?.rounds.map((r) => r.runId)));

  check("a player is never matched against themselves",
    findOpponent(me, [makeBank("me")]).opponent === null);

  check("a different category is not offered",
    findOpponent(me, [makeBank("t", [9, 10, 11, 12])]).opponent === null);

  const mixed = findOpponent(me, [makeBank("mixed", [1, 2, 3, 9, 10, 11])]);
  check("a category queue draws only that category's scenarios from a mixed bank",
    (mixed.candidate?.rounds ?? []).length === 3 &&
      mixed.candidate!.rounds.every((r) => r.scenarioId <= 8),
    mixed.candidate?.rounds.map((r) => r.scenarioId).join(","));

  const subQueue = findOpponent({ ...me, category: "Static" }, [makeBank("s", [1, 2, 3, 4, 5, 6])]);
  check("a sub-skill queue draws only that sub-skill",
    (subQueue.candidate?.rounds ?? []).every((r) => r.scenarioId <= 4) && subQueue.candidate?.rounds.length === 3);

  const hard = makeBank("d");
  hard.rounds = hard.rounds.map((r) => ({ ...r, difficulty: "Advanced" }));
  check("a different difficulty is not offered", findOpponent(me, [hard]).opponent === null);

  check("rounds on scenarios outside the window are never offered",
    findOpponent(me, [makeBank("gone", [1, 2, 97, 98, 99])]).opponent === null);

  // Queueing Any means "I will play whatever". It is a wildcard over categories and
  // nothing else: difficulty still has to agree, because a window is a different set of
  // thresholds rather than a different taste.
  const anyone: MatchmakingCriteria = { ...me, category: "Any" };
  check("queueing Any is matched across categories",
    findOpponent(anyone, [makeBank("t", [9, 10, 11])]).opponent?.playerId === "t");
  check("queueing Any still respects the difficulty",
    findOpponent(anyone, [hard]).opponent === null);
  check("queueing Any is still never matched against yourself",
    findOpponent(anyone, [makeBank("me", [9, 10, 11])]).opponent === null);

  // Three scenarios, not three rounds. Two attempts at one scenario answer one round.
  const doubled = makeBank("doubled", [1, 2]);
  doubled.rounds.push(bankRound("doubled", 2, { runId: "doubled-run-2b", playedAt: new Date("2026-08-10") }));
  check("fewer than three distinct scenarios cannot answer a match",
    findOpponent(me, [doubled]).opponent === null);

  // The most recent attempt answers, because each round was one attempt that counted
  // when it was played - the same single attempt the caller is about to make.
  const twice = makeBank("twice", [1, 2, 3]);
  twice.rounds.push(bankRound("twice", 1, { runId: "twice-old", delta: 0.4, playedAt: new Date("2026-08-01") }));
  const twiceRound = offerableRounds(me, twice).get(1);
  check("the most recent attempt at a scenario is the one offered", twiceRound?.runId === "twice-run-1",
    twiceRound?.runId ?? "none");

  // A round already played against is excluded outright, not merely deprioritised.
  //
  // `recentOpponentIds` keys on the player and costs 25, which is the right shape for
  // "you two have met lately" and the wrong one for "the same attempt against the same
  // frozen number". Replaying a round is not a slightly worse pairing, it is a known
  // answer, and on a thin pool the penalty is paid gladly because there is nothing else
  // to spend it on.
  const facedAll: MatchmakingCriteria = {
    ...me,
    facedRunIds: new Set(["seen-run-1", "seen-run-2", "seen-run-3"]),
  };
  check("rounds already played against are never offered again",
    findOpponent(facedAll, [makeBank("seen", [1, 2, 3])]).opponent === null);

  const partlyFaced = findOpponent(facedAll, [makeBank("seen", [1, 2, 3, 4, 5, 6])]);
  check("the same opponent's unplayed rounds are still offered",
    partlyFaced.opponent?.playerId === "seen" &&
      partlyFaced.candidate!.rounds.every((r) => !facedAll.facedRunIds!.has(r.runId!)),
    partlyFaced.candidate?.rounds.map((r) => r.runId).join(","));

  const legacy = findOpponent({ ...me, facedSideIds: new Set(["old@side"]) }, [makeBank("old", [1, 2, 3])]);
  check("a side faced before copies kept run ids is still excluded", legacy.opponent === null);

  const facedOrNew = findOpponent(facedAll, [
    makeBank("seen", [1, 2, 3], { rating: at(1500) }),
    makeBank("fresh", [1, 2, 3], { rating: at(1900) }),
  ]);
  check("a worse pairing is preferred over one already played",
    facedOrNew.opponent?.playerId === "fresh", facedOrNew.opponent?.playerId ?? "none");

  // Same person, rounds not yet faced. The person penalty applies and is not an
  // exclusion, so a small pool keeps working.
  const sameOpponent = findOpponent({ ...facedAll, recentOpponentIds: new Set(["seen"]) },
    [makeBank("seen", [1, 2, 3, 4, 5, 6])]);
  check("a recent opponent's unplayed rounds are still offered", sameOpponent.opponent?.playerId === "seen");

  check("an empty pool returns no opponent", findOpponent(me, []).opponent === null);

  // ---- variety ------------------------------------------------------------------
  const recent: MatchmakingCriteria = { ...me, playedRecently: new Set([1, 2, 3]) };
  const avoided = findOpponent(recent, [makeBank("wide", [1, 2, 3, 4, 5, 6])]);
  check("scenarios just played are avoided when the opponent can",
    avoided.candidate?.fresh === 3 && avoided.candidate.rounds.every((r) => r.scenarioId > 3),
    avoided.candidate?.rounds.map((r) => r.scenarioId).join(","));

  const narrow = makeBank("narrow", [1, 2, 3]);
  const wide = makeBank("wide", [4, 5, 6]);
  const staleOffer = scoreCandidate(recent, narrow, narrow.rounds);
  const freshOffer = scoreCandidate(recent, wide, wide.rounds);
  check("an offer of scenarios just played costs more", staleOffer.score > freshOffer.score,
    `${staleOffer.score.toFixed(1)} vs ${freshOffer.score.toFixed(1)}`);

  // Fairness still leads: three stale scenarios against an even opponent beat three
  // fresh ones against somebody 400 points away.
  const evenButStale = findOpponent(recent, [
    makeBank("narrow", [1, 2, 3], { rating: at(1500) }),
    makeBank("far", [4, 5, 6], { rating: at(1900) }),
  ]);
  check("fairness outweighs staleness", evenButStale.opponent?.playerId === "narrow",
    evenButStale.opponent?.playerId ?? "none");

  const onlyStale = findOpponent(recent, [makeBank("narrow", [1, 2, 3])]);
  check("an offer of only scenarios just played plants fresh ones instead",
    shouldPlantFresh(recent, onlyStale));
  check("a mostly fresh offer is played, not replaced", !shouldPlantFresh(recent, avoided));

  // A sub-skill window the caller has worked all the way through has nothing fresh to
  // plant, and replacing the match with an unrated one would be the worse kind of boring.
  const exhausted: MatchmakingCriteria = { ...me, category: "Static", playedRecently: new Set([1, 2, 3, 4]) };
  check("nothing is planted when the window has nothing fresh",
    !shouldPlantFresh(exhausted, findOpponent(exhausted, [makeBank("narrow", [1, 2, 3])])));

  const oldRounds = makeBank("old", [1, 2, 3]);
  oldRounds.rounds = oldRounds.rounds.map((r) => ({ ...r, playedAt: new Date("2026-01-01") }));
  const newRounds = makeBank("new", [1, 2, 3]);
  const staleAge = scoreCandidate(me, oldRounds, oldRounds.rounds);
  const recentAge = scoreCandidate(me, newRounds, newRounds.rounds);
  check("older rounds are less preferred", staleAge.score > recentAge.score,
    `${staleAge.score.toFixed(1)} vs ${recentAge.score.toFixed(1)}`);

  const repeat = scoreCandidate({ ...me, recentOpponentIds: new Set(["new"]) }, newRounds, newRounds.rounds);
  check("a recent opponent is penalised", repeat.score > recentAge.score);

  // ---- the repeat that shipped -------------------------------------------------------
  //
  // Six players take turns queueing Clicking, starting from one seeding match. Under the
  // old rule the caller played the opponent's stored three and banked them again, so one
  // set of three was all the category ever played; that is reproduced here first, so the
  // check below is measured against the failure rather than against nothing.
  const PLAYERS_IN_LOOP = 6;
  const QUEUES = 30;
  const clicking = window.filter((s) => s.aimType === "Clicking");

  const simulate = (oldRule: boolean) => {
    const playedBy = new Map<string, number[][]>();
    const banks = new Map<string, OpponentBank>();
    const triples: string[] = [];

    const bank = (id: string) => {
      if (!banks.has(id)) banks.set(id, makeBank(id, [], { rating: at(1500) }));
      return banks.get(id)!;
    };
    const play = (id: string, n: number, scenarioIds: number[]) => {
      for (const s of scenarioIds) {
        bank(id).rounds.push(bankRound(id, s, {
          runId: `${id}-q${n}-${s}`, sideId: `${id}@q${n}`, playedAt: new Date(now.getTime() + n * 60_000),
        }));
      }
      playedBy.set(id, [...(playedBy.get(id) ?? []), scenarioIds]);
      triples.push([...scenarioIds].sort((x, y) => x - y).join(","));
    };

    play("p0", 0, selectScenarios(clicking, "seed-0", { category: "Clicking" }).map((s) => s.id));

    for (let n = 1; n <= QUEUES; n++) {
      const id = `p${n % PLAYERS_IN_LOOP}`;
      const criteria: MatchmakingCriteria = {
        ...me, playerId: id, seed: `queue-${n}`,
        playedRecently: new Set((playedBy.get(id) ?? []).slice(-3).flat()),
        now: new Date(now.getTime() + n * 60_000),
      };

      if (oldRule) {
        // Whoever banked a set most recently, with the set they banked.
        const last = [...banks.values()].filter((b) => b.playerId !== id)
          .flatMap((b) => b.rounds).sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime())[0];
        const set = last ? bank(last.sideId.split("@")[0]).rounds.filter((r) => r.sideId === last.sideId) : [];
        play(id, n, set.map((r) => r.scenarioId));
        continue;
      }

      const result = findOpponent(criteria, [...banks.values()]);
      if (!result.candidate || shouldPlantFresh(criteria, result)) {
        const names = new Set(clicking.filter((s) => criteria.playedRecently!.has(s.id)).map((s) => s.name));
        play(id, n, selectScenarios(clicking, `queue-${n}`, { category: "Clicking", playedRecently: names }).map((s) => s.id));
      } else {
        play(id, n, result.candidate.rounds.map((r) => r.scenarioId));
      }
    }
    return { triples: new Set(triples), scenarios: new Set(triples.flatMap((t) => t.split(","))) };
  };

  const oldRule = simulate(true);
  const newRule = simulate(false);
  console.log(
    `  ${QUEUES} queues: old rule ${oldRule.triples.size} distinct set(s) of three, ` +
      `${oldRule.scenarios.size} scenario(s); now ${newRule.triples.size} sets, ` +
      `${newRule.scenarios.size} of ${clicking.length} scenarios`,
  );
  check("the old rule is reproduced: one set of three, forever", oldRule.triples.size === 1);
  check("matches now draw many different sets of three", newRule.triples.size >= QUEUES / 3,
    `${newRule.triples.size} distinct`);
  check("every scenario in the window gets played", newRule.scenarios.size === clicking.length,
    `${newRule.scenarios.size} of ${clicking.length}`);

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

  // ---- who may queue --------------------------------------------------------------
  //
  // This one refuses to let people play, so it is measured against the corpus on this
  // machine rather than reasoned about. The bar has to be invisible to somebody with a
  // real history and present for somebody with none.
  console.log("\n\u2500\u2500 queue eligibility \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

  let corpusRuns = 0;
  for (const entry of history.values()) corpusRuns += entry.runs.length;

  const real = queueEligibility(corpusRuns);
  console.log(`       ${corpusRuns.toLocaleString()} runs in the corpus, bar is ${MIN_RUNS_TO_QUEUE}`);

  check("a real history clears the bar", real.eligible, `${corpusRuns} runs`);
  check("a fresh account does not", !queueEligibility(0).eligible);
  check("one run short is still short", !queueEligibility(MIN_RUNS_TO_QUEUE - 1).eligible);
  check("exactly the bar is enough", queueEligibility(MIN_RUNS_TO_QUEUE).eligible);

  // The count arrives from a database, so it can arrive missing or nonsense. Failing
  // towards "play more" is the safe direction: the alternative is a null being read as
  // an open door.
  check("a nonsense count is treated as none",
    !queueEligibility(Number.NaN).eligible && !queueEligibility(-5).eligible);

  const short = queueEligibility(43);
  check("the shortfall is what is left to play", short.missing === MIN_RUNS_TO_QUEUE - 43,
    String(short.missing));
  check("nothing is left to play once eligible", queueEligibility(50_000).missing === 0);
  check("the refusal says both numbers",
    eligibilityMessage(short).includes(String(MIN_RUNS_TO_QUEUE)) &&
      eligibilityMessage(short).includes("43"),
    eligibilityMessage(short));

  console.log();
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK: match pipeline validated");
}

main();
