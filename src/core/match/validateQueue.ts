/**
 * Shadows and Flags, held to what docs/fleet/queue.md says about them.
 *
 *   npm run validate:queue      (this, then the PGlite flow over the shipped handlers)
 *
 * Every claim is checked by making it happen rather than by reading code:
 *
 *   THE TABLE        data/shadow_days.json is what its committed inputs produce, the server's
 *                    copy (shadowDays.ts) is the same numbers, and every column rises
 *   CENTRED          a player whose days look like everyone's beats the first Shadow half the
 *                    time, and a p-th percentile Shadow (1 - p) of the time: that is what the
 *                    label promises. The ladder settles on the median for that player, and a
 *                    sharper player places above it
 *   DETERMINISTIC    the same server data fields the same Shadow and the same three scenarios;
 *                    requeueing cannot reroll either
 *   JUDGING          rounds without history read level, a rejected round voids, a draw is a draw
 *   NO RATING        nothing in the Shadow path can reach a rating
 *   FLAGS            planted only from a complete queue Shadow match, settled once by the first
 *                    played answer inside the window, never by a void, a forfeit or a late
 *                    answer; one rating per run set for its owner however many answer it
 *   CORPUS           a stats folder builds a table through the same code (synthetic folder:
 *                    proves the pipeline, not the numbers)
 */

import { readFileSync } from "node:fs";

import { updateRating } from "../rating/glicko2.ts";
import { seededRandom } from "./scenarioSelection.ts";
import type { RoundSubmission } from "./settle.ts";
import {
  drawPercentile,
  explainShadow,
  judgeShadow,
  ladderRung,
  placement,
  planShadow,
  rungStep,
  selectShadowScenarios,
  shadowLabel,
  shadowQuantile,
  shadowRoundDeltas,
  shadowSeed,
  shadowStreak,
  skillOf,
  SHADOW_JITTER,
  SHADOW_RUNGS,
  SHADOW_SKILLS,
  SHADOW_START_RUNG,
  type ShadowRecord,
  type ShadowResult,
  type ShadowTable,
} from "./shadow.ts";
import { modelInputs, modelSpreads, modelTable, PERCENTILES } from "./shadowTable.ts";
import { SHADOW_DAYS } from "./shadowDays.ts";
import {
  applyAnswer,
  canSettle,
  flagStatus,
  FLAG_TTL_MS,
  plantedLine,
  planterRating,
  planterVerdict,
  shadowQueueLine,
  shouldPlant,
  type AnswerFacts,
  type Flag,
} from "./flags.ts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}
const pct = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

// ---------------------------------------------------------------------------
console.log("\nThe table");
// ---------------------------------------------------------------------------
const committed = JSON.parse(read("data/shadow_days.json")) as ShadowTable;
check("the server's copy is the committed table", JSON.stringify(SHADOW_DAYS) === JSON.stringify(committed));
if (committed.method === "model") {
  const inputs = modelInputs(read("src/core/history/baseline.ts"), read("docs/overnight/mechanics.md"), JSON.parse(read("data/fun_audit.json")));
  const fresh = modelTable(inputs, committed.builtAt);
  check("data/shadow_days.json is what its committed inputs produce", JSON.stringify(fresh) === JSON.stringify(committed),
    "npm run build:shadows regenerates it");
  const spreads = modelSpreads(inputs);
  console.log(`       inputs: centre ${pct(inputs.centre, 1)} (baseline rule), three-round day p10/p90 ${pct(inputs.dayP10, 1)} / ${pct(inputs.dayP90, 1)}` +
    ` (ghost table), round noise ${SHADOW_SKILLS.map((s) => `${s} ${pct(inputs.roundNoise[s], 1)}`).join(", ")} (fun_audit)`);
  console.log(`       implied: three-round sigma ${pct(spreads.day3)}, rounds of one day move together at r = ${spreads.correlation.toFixed(2)}`);
  for (const skill of SHADOW_SKILLS) {
    const c = committed.skills[skill];
    check(`${skill}: every column is centred on the measured +0.4%`, [c.k1, c.k2, c.k3].every((col) => Math.abs(col[49] - inputs.centre) < 1e-6));
    check(`${skill}: one round spreads at least as wide as a three-round day`,
      Math.abs(c.k1[9] - inputs.centre) >= Math.abs(c.k3[9] - inputs.centre) - 1e-9 && c.k1[89] >= c.k3[89] - 1e-9);
  }
  // The anchor reproduces itself: pooled three-round p10/p90 is the ghost table's spread.
  check("the pooled three-round day reproduces the measured p10/p90 spread",
    Math.abs((committed.skills.All.k3[89] - committed.skills.All.k3[9]) - (inputs.dayP90 - inputs.dayP10)) < 2e-4,
    `${pct(committed.skills.All.k3[9])} .. ${pct(committed.skills.All.k3[89])}`);
}
for (const skill of SHADOW_SKILLS) {
  for (const k of ["k1", "k2", "k3"] as const) {
    const col = committed.skills[skill][k];
    if (col.length !== 99 || col.some((v, i) => i > 0 && v < col[i - 1])) check(`${skill} ${k} rises through 1..99`, false);
  }
}
check("every column has 99 rising percentiles", SHADOW_SKILLS.every((s) => ["k1", "k2", "k3"].every((k) => {
  const col = committed.skills[s][k as "k1"];
  return col.length === 99 && col.every((v, i) => i === 0 || v >= col[i - 1]);
})));
check("categories file under their skill, Any under all of them",
  skillOf("Precise Tracking") === "Tracking" && skillOf("Static Clicking") === "Clicking" && skillOf("Speed Switching") === "Switching" &&
  skillOf("Tracking") === "Tracking" && skillOf("Any") === "All" && skillOf(null) === "All");

// ---------------------------------------------------------------------------
console.log("\nCentred as claimed");
// ---------------------------------------------------------------------------
// A player whose days are genuine days: each match score is the table's own value at a
// uniformly random percentile. Seeded, so this is the same number on every run.
const random = seededRandom("validate-queue");
const typicalDay = (skill: "All" | "Clicking", shift = 0) => shadowQuantile(SHADOW_DAYS, skill, 3, 1 + random() * 98) + shift;
const winRate = (p: number, n: number, skill: "All" | "Clicking" = "All", shift = 0) => {
  const bar = shadowQuantile(SHADOW_DAYS, skill, 3, p);
  let wins = 0;
  for (let i = 0; i < n; i++) if (typicalDay(skill, shift) > bar) wins++;
  return wins / n;
};
for (const p of [20, 50, 65, 80, 95]) {
  const w = winRate(p, 20000);
  check(`a typical player beats the ${p}th-percentile Shadow ${(100 - p)}% of the time`, Math.abs(w - (1 - p / 100)) < 0.015, `${(w * 100).toFixed(1)}%`);
}
// The first Shadow: rung 2, drawn per player. Over many players its percentile centres on 50.
const firsts = Array.from({ length: 4000 }, (_, i) => planShadow(SHADOW_DAYS, `player-${i}`, [], "Static Clicking").percentile);
const meanFirst = firsts.reduce((a, b) => a + b, 0) / firsts.length;
check("the first Shadow sits on the median rung for everybody", firsts.every((p) => Math.abs(p - 50) <= SHADOW_JITTER),
  `${Math.min(...firsts)}..${Math.max(...firsts)}`);
check("and centres on the 50th percentile", Math.abs(meanFirst - 50) < 0.15, meanFirst.toFixed(2));
check("so a typical player wins it half the time", Math.abs(firsts.reduce((n, p) => n + winRate(p, 5, "Clicking"), 0) / firsts.length - 0.5) < 0.02);

/** Play `n` Shadow matches as a player whose days are shifted by `shift`; return the records. */
function career(id: string, n: number, shift: number): ShadowRecord[] {
  const records: ShadowRecord[] = [];
  for (let i = 0; i < n; i++) {
    const plan = planShadow(SHADOW_DAYS, id, records, "Any");
    const day = typicalDay("All", shift);
    const result: ShadowResult = day > plan.quantiles[2] ? "win" : day < plan.quantiles[2] ? "loss" : "draw";
    records.push({ ordinal: plan.ordinal, percentile: plan.percentile, result });
  }
  return records;
}
const typical = career("typical", 400, 0);
const meanFielded = typical.reduce((a, r) => a + r.percentile, 0) / typical.length;
check("the ladder settles a typical player around the median", Math.abs(meanFielded - 50) < 6, `mean Shadow fielded: ${meanFielded.toFixed(1)}th`);
const typicalPlacements = Array.from({ length: 200 }, (_, i) => placement(career(`t${i}`, 12, 0))!.estimate);
const sharpPlacements = Array.from({ length: 200 }, (_, i) => placement(career(`s${i}`, 12, 0.03))!.estimate);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
check("placement reads a typical player near the 50th", Math.abs(avg(typicalPlacements) - 50) < 5, avg(typicalPlacements).toFixed(1));
check("and a player who shows up 3% sharper well above it", avg(sharpPlacements) > avg(typicalPlacements) + 10, avg(sharpPlacements).toFixed(1));
check("placement waits for three decided results", placement(typical.slice(0, 2)) === null && placement(typical.slice(0, 3)) !== null);

// ---------------------------------------------------------------------------
console.log("\nDeterministic per match");
// ---------------------------------------------------------------------------
const history: ShadowRecord[] = [{ ordinal: 0, percentile: 52, result: "win" }, { ordinal: 1, percentile: 66, result: "loss" }];
const a = planShadow(SHADOW_DAYS, "player-x", history, "Precise Tracking");
const b = planShadow(SHADOW_DAYS, "player-x", history, "Precise Tracking");
check("the same history fields the same Shadow", JSON.stringify(a) === JSON.stringify(b), `${shadowLabel(a.percentile)}, ordinal ${a.ordinal}`);
check("requeueing (no new result) cannot advance the ordinal", planShadow(SHADOW_DAYS, "player-x", [...history], "Any").ordinal === a.ordinal);
check("the percentile is a function of rung and seed alone", drawPercentile(3, shadowSeed("p", 4)) === drawPercentile(3, shadowSeed("p", 4)));
const spread = new Set(Array.from({ length: 200 }, (_, i) => drawPercentile(4, shadowSeed("p", i))));
check("a rung spreads over its jitter and no further", [...spread].every((p) => Math.abs(p - SHADOW_RUNGS[4]) <= SHADOW_JITTER) && spread.size === 2 * SHADOW_JITTER + 1);
const pool = [
  { id: 1, name: "s1", aimType: null, subCategory: "Static Clicking" },
  { id: 2, name: "s2", aimType: null, subCategory: "Static Clicking" },
  { id: 3, name: "s3", aimType: null, subCategory: "Static Clicking" },
  { id: 4, name: "s4", aimType: null, subCategory: "Static Clicking" },
  { id: 5, name: "s5", aimType: null, subCategory: "Static Clicking" },
  { id: 9, name: "t1", aimType: null, subCategory: "Precise Tracking" },
];
const counts = new Map([[4, 9], [5, 2]]);
const drawn = selectShadowScenarios(pool, "seed-1", "Static Clicking", counts);
check("the same seed draws the same three", JSON.stringify(drawn) === JSON.stringify(selectShadowScenarios(pool, "seed-1", "Static Clicking", counts)));
check("measured scenarios first, then ones with some history", drawn[0].id === 4 && drawn[1].id === 5 && drawn[2].subCategory === "Static Clicking",
  drawn.map((s) => s.name).join(", "));
check("a category of two cycles, as selectScenarios does",
  selectShadowScenarios(pool.slice(0, 2), "x", "Static Clicking", new Map()).map((s) => s.id).filter((id, i, all) => all.indexOf(id) === i).length === 2);

// ---------------------------------------------------------------------------
console.log("\nThe ladder");
// ---------------------------------------------------------------------------
check("win up, loss and forfeit down, draw and void stay",
  rungStep("win") === 1 && rungStep("loss") === -1 && rungStep("forfeit") === -1 && rungStep("draw") === 0 && rungStep("void") === 0 && rungStep(null) === 0);
const rec = (results: (ShadowResult | null)[]) => results.map((result, ordinal) => ({ ordinal, percentile: 50, result }));
check("starts on the median rung", ladderRung([]) === SHADOW_START_RUNG && SHADOW_RUNGS[SHADOW_START_RUNG] === 50);
check("is bounded at both ends", ladderRung(rec(Array(20).fill("win"))) === SHADOW_RUNGS.length - 1 && ladderRung(rec(Array(20).fill("forfeit"))) === 0);
check("replays in ordinal order whatever order rows arrive in", ladderRung(rec(["win", "win", "loss"]).reverse()) === 3);
check("the streak counts consecutive wins and steps over voids",
  shadowStreak(rec(["loss", "win", "void", "win"])) === 2 && shadowStreak(rec(["win", "loss"])) === 0 && shadowStreak(rec(["win", null])) === 1);

// ---------------------------------------------------------------------------
console.log("\nJudging a Shadow match");
// ---------------------------------------------------------------------------
const round = (score: number, baseline: number, extra: Partial<RoundSubmission> = {}): RoundSubmission =>
  ({ scenarioId: 1, scenarioName: "s", score, baseline, provisional: false, verificationTier: "consistent", ...extra });
const qs = [0.03, 0.02, 0.01];
check("all three measured: the Shadow's day is the three-round quantile on every round", JSON.stringify(shadowRoundDeltas(qs, [true, true, true])) === "[0.01,0.01,0.01]");
check("one measured: that round carries the one-round quantile, the rest read level", JSON.stringify(shadowRoundDeltas(qs, [false, true, false])) === "[0,0.03,0]");
const won = judgeShadow([round(105, 100), round(105, 100), round(105, 100)], [true, true, true], qs);
check("+5% beats a +1% day", won.verdict === "win" && Math.abs((won.shadowScore ?? 0) - 0.01) < 1e-12);
const level = judgeShadow([round(100, 100), round(100, 100), round(100, 100)], [false, false, false], qs);
check("no history on any round: level at 0%, with the reason stated", level.verdict === "draw" && level.comparable === 0 &&
  /had earlier runs/.test(explainShadow(level, 50, 3, false)));
const partial = judgeShadow([round(100, 100), round(104, 100), round(100, 100)], [false, true, false], qs);
check("one comparable round decides on that round alone", partial.verdict === "win" &&
  /2 of the 3 had no earlier runs/.test(explainShadow(partial, 50, 3, false)), explainShadow(partial, 50, 3, false));
const rejected = judgeShadow([round(130, 100, { verificationTier: "rejected" }), round(101, 100), round(101, 100)], [true, true, true], qs);
check("a rejected round voids the Shadow match, as it would against a person", rejected.verdict === "void");
const tie = judgeShadow([round(101, 100), round(101, 100), round(101, 100)], [true, true, true], qs);
check("level within the draw margin is a draw", tie.verdict === "draw");
const texts = [won, level, partial, rejected, tie].map((j) => explainShadow(j, 53, 3, true));
check("every explanation says nothing was rated, and none says there was no opponent",
  texts.every((t) => /Shadows move no rating\./.test(t) && !/no opponent|Nothing was rated/.test(t)));
check("labels read as English", shadowLabel(53) === "a 53rd-percentile day" && shadowLabel(80) === "an 80th-percentile day" &&
  shadowLabel(8) === "an 8th-percentile day" && shadowLabel(11) === "an 11th-percentile day" && shadowLabel(21) === "a 21st-percentile day" &&
  shadowLabel(12) === "a 12th-percentile day");

// ---------------------------------------------------------------------------
console.log("\nNo rating moves on a Shadow match");
// ---------------------------------------------------------------------------
const shadowSource = read("src/core/match/shadow.ts");
const migration = read("supabase/migrations/20261003000023_shadows_and_flags.sql");
const queueServer = read("supabase/functions/_shared/queue.ts");
check("the Shadow core imports nothing from rating", !/rating\/glicko2|updateRating/.test(shadowSource));
check("commit_shadow_match commits with no rating proposals", /commit_match_result\(p_match_id, p_status, p_sides, '\[\]'::jsonb, false\)/.test(migration));
const shadowSettle = queueServer.slice(queueServer.indexOf("export async function settleShadowMatch"), queueServer.indexOf("export async function shadowResultFor"));
check("the server's Shadow settlement never builds a rating", shadowSettle.length > 0 && !/rating_after|updateRating|p_ratings/.test(shadowSettle));
// The flow test (tools/validateQueueFlow.ts) asserts the same against the database: no
// rating_history row for any match that has a Shadow.
{
  const { matchCardInput } = await import("../brand/shareInput.ts");
  const card = matchCardInput({
    at: Date.now(), sentDuel: false,
    settled: {
      matchId: "m", verdict: null, seeding: true, rated: false, shadow: { label: shadowLabel(51) }, category: "Static Clicking",
      yourMatchScore: 0.1, theirMatchScore: null, ratingAfter: 1500, ratingChange: 0,
      rounds: [{ scenario: "s", score: 110, baseline: 100, delta: 0.1, opponentDelta: 0.005, counted: true, excludedReason: null }],
    },
  }, { season: "Season 1", playerName: "p", tier: null } as never);
  check("a share card of a Shadow result names the Shadow, claims no rating and draws no opponent column",
    "kind" in card && card.mode === "Shadow match, a 51st-percentile day · unrated" && card.player.ratingChange === null &&
    card.opponent === null && card.rounds.every((r) => r.them === null), "kind" in card ? String(card.mode) : "refused");
}

// ---------------------------------------------------------------------------
console.log("\nFlags");
// ---------------------------------------------------------------------------
check("planted from a complete, rated, queue Shadow match", shouldPlant({ rated: true, countedRounds: 3, rounds: 3, shadow: true }));
check("never from a tournament leg, a duel's first leg or an incomplete side",
  !shouldPlant({ rated: false, countedRounds: 3, rounds: 3, shadow: true }) &&
  !shouldPlant({ rated: true, countedRounds: 3, rounds: 3, shadow: false }) &&
  !shouldPlant({ rated: true, countedRounds: 2, rounds: 3, shadow: true }));
const planted = new Date("2026-10-03T12:00:00Z");
const flag: Flag = { id: "f", planterId: "planter", status: "open", plantedAt: planted, expiresAt: new Date(planted.getTime() + FLAG_TTL_MS) };
const at = (ms: number) => new Date(planted.getTime() + ms);
const answer = (who: string, ms: number, outcome: AnswerFacts["outcome"], rated = true): AnswerFacts => ({ answererId: who, answerCreatedAt: at(ms), outcome, rated });
check("open for seven days, then expired", flagStatus(flag, at(FLAG_TTL_MS - 1)) === "open" && flagStatus(flag, at(FLAG_TTL_MS)) === "expired");
check("the first played answer settles it", canSettle(flag, answer("b", 3600_000, "loss")).ok);
for (const [label, facts] of [
  ["a void answer", answer("b", 1, "void")],
  ["a forfeit", answer("b", 1, "forfeit")],
  ["an answer created after expiry", answer("b", FLAG_TTL_MS, "win")],
  ["its own planter", answer("planter", 1, "win")],
  ["an unrated match", answer("b", 1, "win", false)],
] as const) {
  check(`${label} does not settle it`, !canSettle(flag, facts).ok, (canSettle(flag, facts) as { reason?: string }).reason ?? "");
}
// One run set, many answers, in order: the planter is rated exactly once, by the first
// played answer inside the window.
const answers: AnswerFacts[] = [
  answer("b", 1000, "void"), answer("c", 2000, "forfeit"), answer("d", 3000, "win"), answer("e", 4000, "loss"), answer("f", 5000, "draw"),
];
let state = flag;
let planterRatings = 0;
for (const [i, a2] of answers.entries()) {
  const before = state.status;
  state = applyAnswer(state, a2, `m${i}`);
  if (before === "open" && state.status === "answered") planterRatings++;
}
check("one run set answered five times rates its planter once, on the first played answer",
  planterRatings === 1 && state.answerMatchId === "m2", `settled by ${state.answerMatchId}`);
let late = flag;
for (const [i, a2] of [answer("b", FLAG_TTL_MS + 1, "win"), answer("c", 1, "void")].entries()) late = applyAnswer(late, a2, `x${i}`);
check("and never when every answer was void, forfeit or late", late.status === "open");

const even = { rating: 1500, rd: 200, volatility: 0.06 };
const mine = planterRating(even, even, planterVerdict("loss"), 1, updateRating);
const theirs = updateRating(even, [{ opponent: even, score: 0 }]);
check("the planter's step mirrors the answerer's", Math.abs((mine.after.rating - 1500) + (theirs.rating - 1500)) < 1e-9,
  `${pct((mine.after.rating - 1500) / 1500)} of rating`);
const halved = planterRating(even, even, "win", 0.5, updateRating);
check("and is halved when either side leaned on a provisional baseline", Math.abs((halved.after.rating - 1500) - (mine.after.rating - 1500) / 2) < 1e-9);
check("the planter's line says where and how long",
  plantedLine("Intermediate", "Precise Tracking") === "Flag planted: Intermediate band, Precise Tracking. It settles when someone answers it (up to 7 days).");
check("the queue says what will happen before the player commits",
  shadowQueueLine(shadowLabel(51)) === "No one in your band right now. You'll face a Shadow now (a 51st-percentile day), and your run set stays planted as a Flag.");

// ---------------------------------------------------------------------------
console.log("\nCorpus builds");
// ---------------------------------------------------------------------------
{
  const { writeStatsFolder, optionsFor } = await import("../../../tools/fixtures/syntheticStats.ts");
  const { buildCorpus } = await import("../../../tools/buildShadowTable.ts");
  const dir = new URL("../../../.cache/fixture/shadow-corpus/stats", import.meta.url).pathname;
  writeStatsFolder(dir, { ...optionsFor(6000), seed: 11, end: new Date("2026-10-03T18:00:00Z"), clean: true });
  const corpus = buildCorpus(dir, "validate");
  const samples = corpus.inputs.samples as Record<string, number[]>;
  check("a stats folder builds a corpus table through the same code", corpus.method === "corpus" && corpus.percentiles.length === PERCENTILES.length,
    `${samples.All[2]} three-scenario days from 6,000 synthetic runs`);
  check("its columns rise", SHADOW_SKILLS.every((s) => corpus.skills[s].k3.every((v, i, col) => i === 0 || v >= col[i - 1])));
  check("a skill with too few days borrows the pooled column and says so",
    SHADOW_SKILLS.every((s) => s === "All" || (corpus.skills[s].n ?? 0) >= 40 || corpus.skills[s].borrowedFrom === "All"));
}

console.log(`\n${failures === 0 ? "OK" : "FAIL"}: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
