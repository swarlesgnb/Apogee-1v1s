/**
 * Validate ranked v2's rating policy (ranked.ts) and the pieces of matchmaking and
 * settlement it switched on.
 *
 * Three kinds of check. The arithmetic: a v1-shaped call through ranked.ts must be v1
 * exactly, and v2's stakes must be ordered the way a player would expect. The claims:
 * every number ranked.ts and rankedV2.ts quote from the corpus is re-derived here from the
 * stats folder. The decision: the adopted policy must out-predict the first version on
 * every seed of the simulated ladder (compareLadders prints the whole table).
 *
 *   npx tsx src/core/rating/validateRanked.ts [statsFolder]
 */

import { baselineFromScores } from "../history/baseline.ts";
import { scanStatsFolder } from "../history/history.ts";
import { findOpponent, type BankRound, type MatchmakingCriteria, type OpponentBank } from "../match/matchmaking.ts";
import { settleMatch, type RoundSubmission } from "../match/settle.ts";
import { updateRating, type Rating } from "./glicko2.ts";
import {
  inflateForIdle,
  matchWinProbability,
  outcomeGames,
  performanceRating,
  rateForfeit,
  rateResult,
  RANKED_OUTCOME,
  stakes,
} from "./ranked.ts";
import { POLICIES, simulate, WORLDS, SEEDS } from "./compareLadders.ts";

const DEFAULT_STATS_DIR = "E:/Steam/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

const me: Rating = { rating: 1500, rd: 80, volatility: 0.06 };
const them: Rating = { rating: 1450, rd: 60, volatility: 0.06 };

console.log("── the rating policy ────────────────────────────");

check("the adopted outcome model is rounds", RANKED_OUTCOME === "rounds");

// v1 through ranked.ts must be v1 exactly, because settle-match-v2 settles every engine-1
// match this way and claims to settle it as settle-match would.
for (const [won, lost, verdict] of [[2, 1, 1], [1, 2, 0], [1, 1, 0.5]] as const) {
  const v1 = updateRating(me, [{ opponent: them, score: verdict }]);
  const v2 = rateResult({ before: me, opponent: them, tally: { won, lost, tied: won === lost ? 1 : 0 }, model: "match" });
  check(`a ${won}-${lost} under "match" is settle-match's single game`,
    close(v1.rating, v2.after.rating) && close(v1.rd, v2.after.rd) && close(v1.volatility, v2.after.volatility));
}
const halfV1 = updateRating(me, [{ opponent: them, score: 1 }]);
const halfV2 = rateResult({ before: me, opponent: them, tally: { won: 2, lost: 1, tied: 0 }, model: "match", weight: 0.5 });
check("weight damps the change as settle-match does", close(halfV2.after.rating, me.rating + (halfV1.rating - me.rating) * 0.5));
check("weight zero leaves the rating where it was",
  rateResult({ before: me, opponent: them, tally: { won: 3, lost: 0, tied: 0 }, weight: 0 }).after.rating === me.rating);

check("rounds count one game per round", outcomeGames({ won: 2, lost: 1, tied: 0 }, them, "rounds").length === 3);
check("ties count as half", outcomeGames({ won: 1, lost: 1, tied: 1 }, them, "rounds").map((g) => g.score).join() === "1,0,0.5");
check("nothing counted is no games", outcomeGames({ won: 0, lost: 0, tied: 0 }, them, "rounds").length === 0);

const shown = stakes({ before: me, opponent: them });
check("stakes cover every result of three rounds", shown.map((s) => s.result).join() === "3-0,2-1,1-2,0-3");
check("each extra round won is worth more", shown.every((s, i) => i === 0 || s.change < shown[i - 1].change),
  shown.map((s) => `${s.result} ${s.change}`).join(", "));
const forfeit = rateForfeit({ before: me, opponent: them, rounds: 3 });
check("a forfeit costs exactly the 0-3 stake", Math.round(forfeit.after.rating - me.rating) === shown[3].change);

const even = matchWinProbability(me, { ...me });
check("an even match is even", close(even, 0.5, 1e-12));
check("match odds under rounds are sharper than a round's", matchWinProbability(me, them) > matchWinProbability(me, them, "match"));
check("match odds are symmetric", close(matchWinProbability(me, them) + matchWinProbability(them, me), 1, 1e-12));

const perf = performanceRating([{ rating: 1400, rd: 60 }, { rating: 1500, rd: 80 }, { rating: null, rd: null }], { rating: 1700, rd: 50, volatility: 0.06 });
check("a performance is the mean rating its rounds were played at", close(perf.rating, 1450));
check("with the root-mean-square deviation", close(perf.rd, Math.sqrt((60 ** 2 + 80 ** 2) / 2)));
check("rounds with no recorded rating fall back to the owner's current one",
  performanceRating([{ rating: null, rd: null }], { rating: 1700, rd: 50, volatility: 0.06 }).rating === 1700);

// The two numbers ranked.ts quotes for the idle step it measured and did not adopt.
const day = 86_400_000, t0 = new Date("2026-01-01");
const month = inflateForIdle({ rating: 1500, rd: 50, volatility: 0.06 }, t0, new Date(t0.getTime() + 30 * day)).rd;
const half = inflateForIdle({ rating: 1500, rd: 50, volatility: 0.06 }, t0, new Date(t0.getTime() + 180 * day)).rd;
check("idle growth: about 76 after a month", Math.round(month) === 76, month.toFixed(1));
check("idle growth: about 148 after six months", Math.round(half) === 148 || Math.round(half) === 149, half.toFixed(1));
check("idle growth never passes a blank account",
  inflateForIdle({ rating: 1500, rd: 300, volatility: 0.06 }, t0, new Date(t0.getTime() + 3650 * day)).rd === 350);

console.log("\n── matchmaking and settlement switches ─────────");

const pool = [0, 1, 2].map((id) => ({ id, name: `s${id}`, aimType: "Clicking", subCategory: null }));
const round = (scenarioId: number, rating: number): BankRound => ({
  runId: `r${scenarioId}`, scenarioId, score: 100, delta: 0, provisional: false, difficulty: "w",
  playedAt: new Date("2026-10-01"), sideId: "s", strength: { rating, rd: 60 },
});
const bank: OpponentBank = {
  playerId: "b", displayName: "b", rating: { rating: 1700, rd: 60, volatility: 0.06 },
  rounds: [round(0, 1400), round(1, 1400), round(2, 1400)],
};
const criteria: MatchmakingCriteria = { playerId: "a", rating: me, category: "Any", difficulty: "w", pool, seed: "x" };
const current = findOpponent(criteria, [bank]).candidate!;
const atPlay = findOpponent({ ...criteria, strength: "at-play" }, [bank]).candidate!;
check("by default an opponent is their current rating, as v1", current.opponentRating.rating === 1700);
check("at-play judges them by the rating they played at", atPlay.opponentRating.rating === 1400);
check("and the pairing's odds follow", atPlay.winProbability > current.winProbability);

const sub = (score: number, abandoned = false): RoundSubmission => ({
  scenarioId: 0, scenarioName: "s", score, baseline: 100, provisional: false, verificationTier: "consistent", abandoned,
});
const left = [sub(150, true), sub(110), sub(110)];
const against = [sub(100), sub(100), sub(100)];
const v1Left = settleMatch({ playerRounds: left, opponentRounds: against, format: "rounds" });
const v2Left = settleMatch({ playerRounds: left, opponentRounds: against, format: "rounds", abandonedRoundsLose: true });
check("without the switch, leaving early voids, as v1", v1Left.verdict === "void");
check("with it, the round left is lost whatever its partial score", v2Left.roundResults?.join() === "lost,won,won");
check("and the match is decided on the rest", v2Left.verdict === "win" && v2Left.ratingWeight === 1);
check("leaving two of three loses", settleMatch({
  playerRounds: [sub(150, true), sub(150, true), sub(110)], opponentRounds: against, format: "rounds", abandonedRoundsLose: true,
}).verdict === "loss");
check("the switch does nothing to a match decided on deltas",
  settleMatch({ playerRounds: left, opponentRounds: against, format: "mean-delta", abandonedRoundsLose: true }).verdict === "void");

console.log("\n── what the comments quote from the corpus ─────");

const dir = process.argv[2] ?? DEFAULT_STATS_DIR;
const history = scanStatsFolder(dir);
const residuals: number[] = [];
const pairs: [number, number][] = [];
for (const [name, s] of history) {
  const scores = s.runs.map((r) => r.score).filter((x) => x > 0);
  if (scores.length < 30) continue;
  let prev: number | null = null;
  for (let i = 15; i < scores.length; i++) {
    const b = baselineFromScores(name, scores.slice(0, i), null);
    if (!(b.value > 0)) continue;
    const r = Math.log(scores[i] / b.value);
    residuals.push(r);
    if (prev !== null) pairs.push([prev, r]);
    prev = r;
  }
}
if (residuals.length < 1000) {
  check("the stats folder was readable", false, `${residuals.length} residuals from ${dir}`);
} else {
  const sorted = [...residuals].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
  const robust = (q(0.75) - q(0.25)) / 1.349;
  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const mx = pairs.reduce((a, [x]) => a + x, 0) / pairs.length;
  const my = pairs.reduce((a, [, y]) => a + y, 0) / pairs.length;
  const cov = pairs.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
  const vx = pairs.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  const vy = pairs.reduce((a, [, y]) => a + (y - my) ** 2, 0);
  const lag1 = cov / Math.sqrt(vx * vy);
  console.log(`       ${residuals.length} runs against their own trailing baseline`);
  check("one run's robust spread is about 5.5% (simulator: 0.055)", robust > 0.045 && robust < 0.065, robust.toFixed(4));
  check("consecutive runs are close to independent (quoted: 0.06)", Math.abs(lag1) < 0.1, lag1.toFixed(3));
  check("runs sit above their trailing median: players improve (quoted: +1.8%)", mean > 0.005 && mean < 0.04,
    `${(mean * 100).toFixed(1)}%`);
}

console.log("\n── the decision (compare:ladders, one world) ───");

const firstVersion = POLICIES.find((p) => p.name === "first version")!;
const adopted = POLICIES.find((p) => p.name === "rounds + as they played")!;
check("the adopted policy is what ranked.ts runs",
  adopted.outcome === RANKED_OUTCOME && adopted.strength === "at-play" && !adopted.idle);
const world = WORLDS[0];
for (const seed of SEEDS) {
  const a = simulate(firstVersion, world, seed);
  const b = simulate(adopted, world, seed);
  check(`seed ${seed}: v2 predicts results better than v1`, b.logLoss < a.logLoss,
    `log loss ${a.logLoss.toFixed(4)} -> ${b.logLoss.toFixed(4)} over ${b.matches} matches`);
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nOK: ranked v2's policy validated");
