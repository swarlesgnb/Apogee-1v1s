/**
 * Which rating policy learns the ladder best? Measured on a simulated async season.
 *
 * validateMatch's simulated season asks whether Glicko-2 sorts players at all, with
 * random pairings and both sides rated. This asks the narrower question ranked.ts is
 * built on: given the ladder as it actually runs - async, only the caller rated, an
 * opponent who is a frozen performance, players who improve, take breaks and arrive late
 * - which policy predicts results best?
 *
 * The production code runs here, not a model of it: findOpponent picks the opponent from
 * banks of frozen rounds, shouldPlantFresh hands out seeding matches, seedRating starts
 * every newcomer, and ranked.ts / glicko2.ts move the ratings.
 *
 * WHAT IS MEASURED AND WHAT IS ASSUMED
 *
 * One run's noise is measured: the corpus's runs sit around their own trailing median
 * (baseline.ts) with a robust spread of 5.5% and a fat lower tail, and a player's
 * consecutive residuals correlate at 0.06, so rounds are drawn independently. Real
 * players improve: the same residuals average +1.8%.
 *
 * Assumed, because one machine's stats folder cannot say it: how far apart players are
 * (a spread of 15% in score), how much a player's scenarios differ from each other (4%),
 * how fast people improve, how often they play, how long their breaks are and whether
 * skill moves while they are away. Every conclusion is therefore reported in four worlds
 * that vary those assumptions, three seeds each, and a policy is adopted only when it is
 * better on balance and never worse anywhere by more than seed noise. ranked.ts carries
 * the table and what was adopted.
 *
 * The score is log loss on each rated match's outcome, predicted from the ratings as they
 * stood when the match was handed out: the one number that says whether a rating knows
 * who will win. Lower is better; 0.693 is a coin flip.
 *
 *   npx tsx src/core/rating/compareLadders.ts
 */

import { findOpponent, shouldPlantFresh, type BankRound, type MatchmakingCriteria, type OpponentBank } from "../match/matchmaking.ts";
import { seededRandom, selectScenarios, type SelectableScenario } from "../match/scenarioSelection.ts";
import { updateRating, type Rating } from "./glicko2.ts";
import { inflateForIdle, matchWinProbability, rateResult, type OutcomeModel } from "./ranked.ts";
import { seedRating } from "./seed.ts";

export interface Policy {
  name: string;
  idle: boolean;
  strength: "current" | "at-play";
  outcome: OutcomeModel;
}

export const POLICIES: Policy[] = [
  { name: "first version", idle: false, strength: "current", outcome: "match" },
  { name: "rounds as games", idle: false, strength: "current", outcome: "rounds" },
  { name: "rounds + as they played", idle: false, strength: "at-play", outcome: "rounds" },
  { name: "rounds + idle time", idle: true, strength: "current", outcome: "rounds" },
  { name: "all three", idle: true, strength: "at-play", outcome: "rounds" },
];

export interface World {
  label: string;
  /** Spread of players' underlying skill, in log score. */
  skillSpread: number;
  /** Mean improvement per active day, in log score. */
  improvement: number;
  /** Share of players who take one long break. */
  breakShare: number;
  /**
   * How far skill wanders per day away from the ladder, in log score. Zero is a player who
   * comes back exactly as they left; more is somebody who kept playing KovaaK's, or
   * stopped aiming at all, and returns a different player.
   */
  awayDrift: number;
}

export const WORLDS: World[] = [
  { label: "as assumed", skillSpread: 0.15, improvement: 0.0012, breakShare: 0.35, awayDrift: 0 },
  { label: "fast improvers", skillSpread: 0.15, improvement: 0.003, breakShare: 0.35, awayDrift: 0 },
  { label: "tight field, few breaks", skillSpread: 0.08, improvement: 0.0006, breakShare: 0.1, awayDrift: 0 },
  { label: "skill wanders while away", skillSpread: 0.15, improvement: 0.0012, breakShare: 0.35, awayDrift: 0.006 },
];

const PLAYERS = 150;
const DAYS = 120;
const SCENARIOS = 12;
/** Matches before predictions are scored, so every policy is past its own cold start. */
const BURN_IN_DAYS = 20;
/** Only a player's newest rounds are kept as their bank, as the pool query bounds them. */
const BANK_ROUNDS = 60;
/** Opponents considered per queue: the nearest by rating, as ranked_pool_rounds reads them. */
const POOL_PLAYERS = 40;
const RECENT_OPPONENT_DAYS = 7;
const DAY_MS = 86_400_000;

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** One run's residual: measured spread, with the corpus's fat lower tail. */
function runNoise(rng: () => number): number {
  return rng() < 0.95 ? gaussian(rng) * 0.055 : -0.1 + gaussian(rng) * 0.2;
}

interface Sim {
  base: number;
  /** Accumulated wander from days away (World.awayDrift). */
  drift: number;
  rate: number;
  affinity: number[];
  joinDay: number;
  activity: number;
  breakFrom: number;
  breakTo: number;
  activeDays: number;
  rating: Rating;
  lastRatedAt: Date | null;
  rated: number;
  rounds: BankRound[];
  faced: Set<string>;
  opponents: { id: string; day: number }[];
  recentScenarios: number[][];
  returnedAt: number | null;
}

export interface Score {
  matches: number;
  logLoss: number;
  brier: number;
  /** Mean predicted minus actual win rate: positive is a ladder that overrates callers. */
  bias: number;
  returnersLogLoss: number;
  newcomersLogLoss: number;
  spearman: number;
}

function skillAt(p: Sim, scenario: number): number {
  return p.base + p.drift + p.rate * p.activeDays + p.affinity[scenario];
}

export function simulate(policy: Policy, world: World, seed: string): Score {
  const rng = seededRandom(`${seed}:${world.label}`);
  const pool: SelectableScenario[] = Array.from({ length: SCENARIOS }, (_, i) => ({
    id: i, name: `scenario ${i}`, aimType: "Clicking", subCategory: null,
  }));

  const players: Sim[] = Array.from({ length: PLAYERS }, () => {
    const breaks = rng() < world.breakShare;
    const breakFrom = breaks ? Math.floor(20 + rng() * 60) : Infinity;
    return {
      base: gaussian(rng) * world.skillSpread,
      drift: 0,
      rate: Math.max(0, world.improvement + gaussian(rng) * world.improvement * 0.8),
      affinity: Array.from({ length: SCENARIOS }, () => gaussian(rng) * 0.04),
      joinDay: rng() < 0.4 ? 0 : Math.floor(rng() * 90),
      activity: 0.15 + rng() * 0.55,
      breakFrom,
      breakTo: breakFrom + 21 + Math.floor(rng() * 55),
      activeDays: 0,
      rating: { rating: 1500, rd: 350, volatility: 0.06 },
      lastRatedAt: null,
      rated: 0,
      rounds: [],
      faced: new Set(),
      opponents: [],
      recentScenarios: [],
      returnedAt: null,
    };
  });

  // Seeded as production seeds: by where verified PBs put a player among everybody else,
  // which is a noisy read of their skill on the day they join.
  const seen = players.map((p) => p.base + gaussian(rng) * 0.05);
  const sorted = [...seen].sort((a, b) => a - b);
  players.forEach((p, i) => {
    p.rating = seedRating(sorted.indexOf(seen[i]) / (PLAYERS - 1));
  });

  let n = 0, logLoss = 0, brier = 0, bias = 0;
  const returners: number[] = [];
  const newcomers: number[] = [];
  let runSerial = 0;

  for (let day = 0; day < DAYS; day++) {
    const now = new Date(Date.UTC(2026, 0, 1) + day * DAY_MS);
    const today = players
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => day >= p.joinDay && !(day >= p.breakFrom && day < p.breakTo) && rng() < p.activity);

    for (const p of players) {
      if (day >= p.breakFrom && day < p.breakTo && world.awayDrift > 0) p.drift += gaussian(rng) * world.awayDrift;
    }

    for (const { p } of today) {
      p.activeDays++;
      if (day === p.breakTo || (p.breakTo < day && p.returnedAt === null && p.breakFrom < day)) {
        p.returnedAt ??= p.rated;
      }
    }

    // Interleaved, a match each per pass, the way a day's queue actually fills.
    const queue = today.flatMap(({ p, i }) => Array.from({ length: 1 + Math.floor(rng() * 4) }, () => ({ p, i })));
    for (let k = queue.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [queue[k], queue[j]] = [queue[j], queue[k]];
    }

    for (const { p, i } of queue) {
      const before = policy.idle ? idleBefore(p, now) : p.rating;
      const playedRecently = new Set(p.recentScenarios.flat());
      const criteria: MatchmakingCriteria = {
        playerId: `p${i}`,
        rating: before,
        category: "Any",
        difficulty: "window",
        pool,
        seed: `${seed}:${day}:${runSerial}`,
        now,
        recentOpponentIds: new Set(p.opponents.filter((o) => day - o.day < RECENT_OPPONENT_DAYS).map((o) => o.id)),
        playedRecently,
        facedRunIds: p.faced,
        strength: policy.strength,
      };
      const banks: OpponentBank[] = players
        .map((o, j) => ({ playerId: `p${j}`, displayName: `p${j}`, rating: o.rating, rounds: o.rounds }))
        .filter((b) => b.rounds.length > 0 && b.playerId !== `p${i}`)
        .sort((x, y) => Math.abs(x.rating.rating - before.rating) - Math.abs(y.rating.rating - before.rating))
        .slice(0, POOL_PLAYERS);

      const result = findOpponent(criteria, banks);
      const plant = shouldPlantFresh(criteria, result);

      const scenarioIds = result.candidate && !plant
        ? result.candidate.rounds.map((r) => r.scenarioId)
        : selectScenarios(pool, criteria.seed, {
            category: "Any",
            playedRecently: new Set(pool.filter((s) => playedRecently.has(s.id)).map((s) => s.name)),
          }).map((s) => s.id);

      const performances = scenarioIds.map((s) => skillAt(p, s) + runNoise(rng));

      if (result.candidate && !plant) {
        const c = result.candidate;
        const tally = { won: 0, lost: 0, tied: 0 };
        c.rounds.forEach((r, k) => {
          const mine = performances[k];
          if (mine > r.score) tally.won++;
          else if (mine < r.score) tally.lost++;
          else tally.tied++;
          if (r.runId) p.faced.add(r.runId);
        });

        const predicted = matchWinProbability(before, c.opponentRating, policy.outcome);
        const won = tally.won > tally.lost ? 1 : 0;
        if (day >= BURN_IN_DAYS) {
          const q = Math.min(1 - 1e-9, Math.max(1e-9, predicted));
          const loss = -(won * Math.log(q) + (1 - won) * Math.log(1 - q));
          n++;
          logLoss += loss;
          brier += (q - won) ** 2;
          bias += q - won;
          if (p.returnedAt !== null && p.rated - p.returnedAt < 5) returners.push(loss);
          if (p.joinDay >= BURN_IN_DAYS && p.rated < 10) newcomers.push(loss);
        }

        if (policy.outcome === "match" && !policy.idle) {
          // The first version exactly: one game, no idle growth.
          p.rating = updateRating(p.rating, [{ opponent: c.opponentRating, score: won ? 1 : 0 }]);
        } else {
          p.rating = rateResult({ before, opponent: c.opponentRating, tally, model: policy.outcome }).after;
        }
        p.lastRatedAt = now;
        p.rated++;
        p.opponents.push({ id: c.bank.playerId, day });
      }

      // Every side played goes into its owner's bank, rated or not, as it does on the server.
      scenarioIds.forEach((scenarioId, k) => {
        p.rounds.push({
          runId: `r${runSerial++}`,
          scenarioId,
          score: performances[k],
          delta: 0,
          provisional: false,
          difficulty: "window",
          playedAt: now,
          sideId: `s${runSerial}`,
          strength: { rating: before.rating, rd: before.rd },
        });
      });
      if (p.rounds.length > BANK_ROUNDS) p.rounds.splice(0, p.rounds.length - BANK_ROUNDS);
      p.recentScenarios.unshift(scenarioIds);
      p.recentScenarios.length = Math.min(p.recentScenarios.length, 3);
    }
  }

  const ranked = players.filter((p) => p.rated >= 10);
  const truth = ranked.map((p) => p.base + p.drift + p.rate * p.activeDays);
  const spearman = rankCorrelation(truth, ranked.map((p) => p.rating.rating));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  return {
    matches: n,
    logLoss: logLoss / n,
    brier: brier / n,
    bias: bias / n,
    returnersLogLoss: mean(returners),
    newcomersLogLoss: mean(newcomers),
    spearman,
  };
}

function idleBefore(p: Sim, now: Date): Rating {
  return inflateForIdle(p.rating, p.lastRatedAt, now);
}

function rankCorrelation(a: number[], b: number[]): number {
  const ranks = (xs: number[]) => {
    const order = xs.map((x, i) => ({ x, i })).sort((u, v) => u.x - v.x);
    const r = new Array(xs.length);
    order.forEach((o, k) => { r[o.i] = k; });
    return r as number[];
  };
  const ra = ranks(a), rb = ranks(b), n = a.length;
  const d2 = ra.reduce((sum, r, i) => sum + (r - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export const SEEDS = ["ladder-a", "ladder-b", "ladder-c"];

/** Every policy in every world, averaged over the seeds. */
export interface Row {
  world: World;
  policy: Policy;
  score: Score;
  logLossSd: number;
  /** Log loss per seed, in SEEDS order, so two policies can be compared seed by seed. */
  perSeed: number[];
}

export function compareAll(): Row[] {
  const out: Row[] = [];
  for (const world of WORLDS) {
    for (const policy of POLICIES) {
      const runs = SEEDS.map((seed) => simulate(policy, world, seed));
      const avg = (key: keyof Score) => runs.reduce((sum, r) => sum + r[key], 0) / runs.length;
      const mean = avg("logLoss");
      out.push({
        world, policy,
        // Between seeds, so a gap between two policies can be read against it.
        logLossSd: Math.sqrt(runs.reduce((sum, r) => sum + (r.logLoss - mean) ** 2, 0) / runs.length),
        perSeed: runs.map((r) => r.logLoss),
        score: {
          matches: avg("matches"), logLoss: avg("logLoss"), brier: avg("brier"), bias: avg("bias"),
          returnersLogLoss: avg("returnersLogLoss"), newcomersLogLoss: avg("newcomersLogLoss"),
          spearman: avg("spearman"),
        },
      });
    }
  }
  return out;
}

function main(): void {
  const rows = compareAll();
  for (const world of WORLDS) {
    console.log(`\n── ${world.label} ${"─".repeat(Math.max(0, 44 - world.label.length))}`);
    console.log("  policy                      log loss (±seeds)  brier   bias    returners newcomers spearman");
    for (const { policy, score, logLossSd } of rows.filter((r) => r.world === world)) {
      console.log(
        `  ${policy.name.padEnd(27)} ${score.logLoss.toFixed(4)} (±${logLossSd.toFixed(4)})  ${score.brier.toFixed(4)}  ` +
          `${(score.bias >= 0 ? "+" : "") + score.bias.toFixed(3)}  ${score.returnersLogLoss.toFixed(4)}    ` +
          `${score.newcomersLogLoss.toFixed(4)}    ${score.spearman.toFixed(3)}`,
      );
    }
    console.log(`  (${Math.round(rows.find((r) => r.world === world)!.score.matches)} scored matches per run)`);

    // Seed by seed, because every policy plays the same seeds: a gap smaller than the
    // spread between seeds can still be one that holds on every one of them.
    const inWorld = rows.filter((r) => r.world === world);
    const paired = (a: Row, b: Row) => {
      const better = a.perSeed.filter((x, i) => x < b.perSeed[i]).length;
      const gap = a.score.logLoss - b.score.logLoss;
      return `${gap >= 0 ? "+" : ""}${gap.toFixed(4)}, better on ${better} of ${a.perSeed.length} seeds`;
    };
    const [first, rounds] = inWorld;
    for (const row of inWorld.slice(1)) console.log(`  ${row.policy.name.padEnd(27)} vs first version: ${paired(row, first)}`);
    for (const row of inWorld.slice(2)) console.log(`  ${row.policy.name.padEnd(27)} vs rounds alone:  ${paired(row, rounds)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` ||
    process.argv[1]?.endsWith("compareLadders.ts")) {
  main();
}
