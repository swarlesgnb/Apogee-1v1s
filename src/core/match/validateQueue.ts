/**
 * Shadows and Flags under ranked v2, held to what docs/fleet/queue.md says about them.
 *
 *   npm run validate:queue      (this, then the PGlite flow over the shipped handlers)
 *
 *   THE TABLE        data/shadow_scores.json is exactly what Season 1's committed numbers
 *                    produce, the server's copy matches it, every point reproduces a
 *                    committed threshold or median, and nothing outside them is scored
 *   THE LADDER       every rung, with its jitter, has a committed score on every scenario
 *                    in the match window; draws are deterministic and cannot be rerolled
 *   JUDGING          raw score, best of three, by ranked's own settleMatch; uncovered
 *                    rounds are not contested; rejected rounds void
 *   NO RATING        nothing in the Shadow path can reach a rating
 *   FLAGS            news from raw scores by ranked's rule, and only when it agrees with
 *                    the verdict settlement stored
 */

import { readFileSync } from "node:fs";

import { windowRankIndices } from "../season/windows.ts";
import type { RoundSubmission } from "./settle.ts";
import {
  drawPercentile,
  explainShadow,
  judgeShadow,
  ladderRung,
  planShadow,
  rungStep,
  shadowLabel,
  shadowScoreAt,
  shadowSeed,
  shadowStanding,
  shadowStreak,
  SHADOW_JITTER,
  SHADOW_RUNGS,
  SHADOW_START_RUNG,
  type ShadowRecord,
  type ShadowResult,
  type ShadowScoreTable,
} from "./shadow.ts";
import { buildShadowScores } from "./shadowSource.ts";
import { SHADOW_SCORES } from "./shadowScores.ts";
import { bankNewsLine, bankTally, shadowQueueLine } from "./flags.ts";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
console.log("\nThe table");
// ---------------------------------------------------------------------------
const season = JSON.parse(read("data/seasons/season-1.json"));
const families = JSON.parse(read("data/season-1/families.json"));
const pool = JSON.parse(read("data/pool.json"));
const committed = JSON.parse(read("data/shadow_scores.json")) as ShadowScoreTable;
const fresh = buildShadowScores(season, families, pool);
check("data/shadow_scores.json is what the season's committed files produce", JSON.stringify(fresh.table) === JSON.stringify(committed),
  "npm run build:shadows regenerates it");
check("the server's copy is the committed table", JSON.stringify(SHADOW_SCORES) === JSON.stringify(committed));
check("every season scenario has a row", season.scenarios.every((s: any) => committed.scenarios[s.scenario]),
  `${Object.keys(committed.scenarios).length} of ${season.scenarios.length}`);
check("no median had to be left out", fresh.skippedMedians.length === 0, fresh.skippedMedians.map((s) => s.scenario).join(", "));

// Every point is a committed number: a threshold at its ladder percentile, or the median.
let reproduced = 0;
let wrong: string[] = [];
const medians = new Map(families.scenarios.map((f: any) => [f.scenario, f.median]));
for (const s of season.scenarios) {
  const fractions = windowRankIndices(s.window ?? 0, season.windowSize ?? pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap)
    .map((i: number) => pool.ladder.ranks[i]);
  for (const [i, score] of s.rankMaxes.entries()) {
    const at = shadowScoreAt(committed, s.scenario, Math.round(100 * (1 - fractions[i]) * 100) / 100);
    if (at === score) reproduced++;
    else wrong.push(`${s.scenario} rank ${i + 1}: ${at} vs ${score}`);
  }
  const median = shadowScoreAt(committed, s.scenario, 50);
  const expected = Math.round((medians.get(s.scenario) as number) * (s.source?.factor ?? 1));
  if (median === expected) reproduced++;
  else wrong.push(`${s.scenario} median: ${median} vs ${expected}`);
}
check("every committed threshold and median reads back exactly", wrong.length === 0, wrong.length ? wrong.slice(0, 3).join("; ") : `${reproduced} points`);
check("every scenario's points rise with the percentile",
  Object.values(committed.scenarios).every((r) => r.points.every((p, i) => i === 0 || (p[0] > r.points[i - 1][0] && p[1] >= r.points[i - 1][1]))));
const galaga = committed.scenarios["Apogee Galaga Intermediate"];
check("between two committed points the score is interpolated, linearly", (() => {
  const [a, b] = [galaga.points[0], galaga.points[1]];
  const mid = (a[0] + b[0]) / 2;
  return Math.abs((shadowScoreAt(committed, "Apogee Galaga Intermediate", mid) as number) - (a[1] + b[1]) / 2) <= 0.05;
})());
check("outside the committed points there is no score, not the nearest one",
  shadowScoreAt(committed, "Apogee Galaga Intermediate", 49) === null && shadowScoreAt(committed, "Apogee Galaga Intermediate", 95) === null &&
  shadowScoreAt(committed, "a scenario the season does not have", 60) === null);

// ---------------------------------------------------------------------------
console.log("\nThe ladder");
// ---------------------------------------------------------------------------
const matchWindow = Number(pool.matchWindow ?? 1);
const windowRows = Object.entries(committed.scenarios).filter(([, r]) => r.window === matchWindow);
const lowest = Math.min(...SHADOW_RUNGS) - SHADOW_JITTER;
const highest = Math.max(...SHADOW_RUNGS) + SHADOW_JITTER;
const uncovered = windowRows.filter(([name]) => shadowScoreAt(committed, name, lowest) === null || shadowScoreAt(committed, name, highest) === null);
check(`every rung, jitter included (${lowest} to ${highest}), has a committed score on all ${windowRows.length} match-window scenarios`,
  uncovered.length === 0, uncovered.map(([n]) => n).slice(0, 3).join(", "));
check("win up, loss and forfeit down, draw and void stay",
  rungStep("win") === 1 && rungStep("loss") === -1 && rungStep("forfeit") === -1 && rungStep("draw") === 0 && rungStep("void") === 0 && rungStep(null) === 0);
const rec = (results: (ShadowResult | null)[]) => results.map((result, ordinal) => ({ ordinal, percentile: 50, result }));
check("starts on the bottom rung, a median score", ladderRung([]) === SHADOW_START_RUNG && Math.abs(SHADOW_RUNGS[SHADOW_START_RUNG] - 50) <= SHADOW_JITTER);
check("is bounded at both ends", ladderRung(rec(Array(20).fill("win"))) === SHADOW_RUNGS.length - 1 && ladderRung(rec(Array(20).fill("forfeit"))) === 0);
check("replays in ordinal order whatever order rows arrive in", ladderRung(rec(["win", "win", "loss"]).reverse()) === 1);
const firsts = Array.from({ length: 2000 }, (_, i) => planShadow(committed, `player-${i}`, [], []).percentile);
check("the first Shadow is 50 to 54 for everybody", firsts.every((p) => p >= 50 && p <= 54), `mean ${(firsts.reduce((a, b) => a + b, 0) / firsts.length).toFixed(2)}`);
const names = windowRows.slice(0, 3).map(([n]) => n);
const history: ShadowRecord[] = [{ ordinal: 0, percentile: 52, result: "win" }, { ordinal: 1, percentile: 58, result: "loss" }];
const a = planShadow(committed, "player-x", history, names);
check("the same history fields the same Shadow on the same three", JSON.stringify(a) === JSON.stringify(planShadow(committed, "player-x", history, names)),
  `${shadowLabel(a.percentile)}: ${a.scores.join(" · ")}`);
check("requeueing (no new result) cannot advance the ordinal", planShadow(committed, "player-x", [...history], names).ordinal === a.ordinal);
const spread = new Set(Array.from({ length: 300 }, (_, i) => drawPercentile(4, shadowSeed("p", i))));
check("a rung spreads over its jitter and no further", [...spread].every((p) => Math.abs(p - SHADOW_RUNGS[4]) <= SHADOW_JITTER) && spread.size === 2 * SHADOW_JITTER + 1);
check("the Shadow is harder up the ladder on every scenario", windowRows.every(([n]) =>
  SHADOW_RUNGS.every((p, i) => i === 0 || (shadowScoreAt(committed, n, p) as number) >= (shadowScoreAt(committed, n, SHADOW_RUNGS[i - 1]) as number))));

// ---------------------------------------------------------------------------
console.log("\nJudging a Shadow match");
// ---------------------------------------------------------------------------
const round = (score: number, extra: Partial<RoundSubmission> = {}): RoundSubmission =>
  ({ scenarioId: 1, scenarioName: "s", score, baseline: 100, provisional: false, verificationTier: "consistent", ...extra });
const two1 = judgeShadow([round(1200), round(900), round(1500)], [1100, 1000, 1400]);
check("raw score decides each round; best of three decides the match", two1.verdict === "win" && JSON.stringify(two1.rounds) === '["won","lost","won"]' &&
  two1.tally.won === 2 && two1.tally.lost === 1);
check("a higher delta does not save a lower score", judgeShadow([round(900, { baseline: 500 })], [1000]).verdict === "loss");
const tied = judgeShadow([round(1000), round(1100), round(900)], [1000, 1000, 1000]);
check("equal scores tie a round", tied.verdict === "draw" && tied.tally.tied === 1, JSON.stringify(tied.tally));
const gap = judgeShadow([round(1200), round(900), round(1500)], [1100, null, 1400]);
check("a round with no committed score is not contested and says so", gap.verdict === "win" && gap.contested === 2 && gap.rounds[1] === "no-score" &&
  /One scenario has no committed score at that percentile/.test(explainShadow(gap, 92, 3)), explainShadow(gap, 92, 3));
const none = judgeShadow([round(1200)], [null]);
check("no committed score anywhere is no result, with the reason", none.verdict === "void" && /none of these scenarios has a committed score/.test(explainShadow(none, 92, 1)));
check("a rejected run voids the Shadow match, as it would against a person",
  judgeShadow([round(1300, { verificationTier: "rejected" }), round(1200), round(1200)], [1000, 1000, 1000]).verdict === "void");
const texts = [two1, tied, gap, none].map((j) => explainShadow(j, 58, 3));
check("every explanation says nothing was rated, and none says there was no opponent",
  texts.every((t) => /Shadows move no rating\./.test(t) && !/no opponent|Nothing was rated/.test(t)), texts[0]);
check("labels read as English", shadowLabel(52) === "a 52nd-percentile score on each" && shadowLabel(86) === "an 86th-percentile score on each" &&
  shadowLabel(58) === "a 58th-percentile score on each" && shadowLabel(71) === "a 71st-percentile score on each");

// ---------------------------------------------------------------------------
console.log("\nThe read-out");
// ---------------------------------------------------------------------------
const run: ShadowRecord[] = [
  { ordinal: 0, percentile: 52, result: "win", won: 2, lost: 1, tied: 0 },
  { ordinal: 1, percentile: 58, result: "win", won: 3, lost: 0, tied: 0 },
  { ordinal: 2, percentile: 65, result: "loss", won: 1, lost: 2, tied: 0 },
  { ordinal: 3, percentile: 58, result: "void", won: null },
];
const st = shadowStanding(run);
check("the read-out is a bracket, not a model", st.highestBeaten === 58 && st.lostAbove === 65 && st.roundsWon === 6 && st.roundsContested === 9,
  JSON.stringify(st));
check("the streak counts consecutive wins and steps over voids", shadowStreak(rec(["loss", "win", "void", "win"])) === 2 && shadowStreak(rec(["win", "loss"])) === 0);

// ---------------------------------------------------------------------------
console.log("\nNo rating moves on a Shadow match");
// ---------------------------------------------------------------------------
const migration = read("supabase/migrations/20261011000004_shadows_and_flags.sql");
const queueServer = read("supabase/functions/_shared/queue.ts");
check("the Shadow core imports nothing from rating", !/rating\/|updateRating|rateResult/.test(read("src/core/match/shadow.ts")));
check("commit_shadow_match commits with no rating proposals", /commit_match_result\(p_match_id, 'settled', p_sides, '\[\]'::jsonb, false\)/.test(migration));
const shadowSettle = queueServer.slice(queueServer.indexOf("export async function settleShadowMatch"), queueServer.indexOf("export async function shadowResultFor"));
check("the server's Shadow settlement never builds a rating", shadowSettle.length > 0 && !/rating_after|rateResult|p_ratings/.test(shadowSettle));
check("the rated-for-both Flag settlement is gone", !/commit_flag_answer|create table flags/.test(migration) && !/commitFlagAnswer|prepareFlagAnswer/.test(queueServer));

// ---------------------------------------------------------------------------
console.log("\nFlags: news about your banked rounds");
// ---------------------------------------------------------------------------
const t21 = bankTally([1000, 1000, 1000], [1100, 900, 1200], "win");
check("rounds each way by ranked's rule, the higher raw score taking it", t21?.theirs === 2 && t21?.yours === 1);
check("the line says who played and how many they took", bankNewsLine("kestrel", t21, "win") === "kestrel played your banked rounds and took 2 of 3.");
check("a tally that disagrees with the stored verdict is not reported",
  bankTally([1000, 1000, 1000], [1100, 900, 1200], "loss") === null && bankNewsLine("rook", null, "loss") === "rook played your banked rounds and lost.");
check("ties are named", bankNewsLine("juno", bankTally([1000, 1000, 1000], [1000, 1100, 900], "draw"), "draw") === "juno played your banked rounds and took 1 of 3 (1 tied).");
check("the queue line explains find-match's own planting, both ways",
  /^No one in your band right now\. You'll face a Shadow now \(a 52nd-percentile score on each\), and your three runs join the bank/.test(shadowQueueLine(shadowLabel(52), false)) &&
  /scenarios you just played, so this is three fresh ones/.test(shadowQueueLine(shadowLabel(52), true)));

console.log(`\n${failures === 0 ? "OK" : "FAIL"}: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
