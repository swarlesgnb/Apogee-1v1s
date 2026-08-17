/**
 * Build the player-state snapshot the UI renders.
 *
 * Shared by the CLI exporter and the Electron main process, so the desktop app and the
 * static preview cannot drift apart: there is one definition of "what the player's
 * state is", and both read it.
 */

import { readFileSync } from "node:fs";

import { evaluateBenchmark } from "../benchmarks/energy.ts";
import type { BenchmarkDef, DifficultyDef } from "../benchmarks/types.ts";
import { dataFile } from "../dataDir.ts";
import { computeBaseline, scanStatsFolder, type ScenarioHistory } from "../history/history.ts";
import { selectScenarios, type SelectableScenario } from "../match/scenarioSelection.ts";
import { explainVerdict, settleMatch, type RoundSubmission } from "../match/settle.ts";
import { generateQuests, playStreak, questProgress } from "../quests/generate.ts";
import { defaultRating, updateRating, winProbability } from "../rating/glicko2.ts";
import { loadRankTheme, tierForPercentile, type RankTier } from "../ranks/apogeeRanks.ts";
import { floorsFor, overallGap } from "../consistency/floor.ts";

export interface SnapshotOptions {
  statsDir: string;
  /** Defaults to the committed Voltaic S5 definition. */
  benchmarkPath?: string | URL;
  now?: Date;
}

export interface Snapshot {
  generatedAt: string;
  benchmark: {
    name: string;
    difficulty: string;
    rankNames: string[];
    rankColors: Record<string, string>;
  };
  player: {
    totalRuns: number;
    scenarioCount: number;
    streak: number;
    benchmarkRank: string | null;
    benchmarkEnergy: number;
    progressToNextRank: number | null;
    nextRankName: string | null;
    apogee: {
      rating: number;
      rd: number;
      percentile: number;
      tier: RankTier;
    };
  };
  theme: RankTier[];
  categories: unknown[];
  weakest: string;
  /** Floor rank and per-scenario gaps. See core/consistency. */
  consistency: {
    method: string;
    ceilingRank: string | null;
    ceilingEnergy: number;
    floorRank: string | null;
    floorEnergy: number;
    gap: number;
    scenarios: {
      name: string;
      label: string;
      ceiling: number;
      floor: number;
      median: number;
      gap: number;
    }[];
  };
  match: unknown;
  quests: unknown[];
}

export function shortName(scenario: string, difficulty: string): string {
  return scenario
    .replace(/^VT /, "")
    .replace(new RegExp(`\\s*${difficulty.split(" ")[0]}\\s*`, "i"), " ")
    .replace(/\s*S\d(\.\d)?\s*$/i, "")
    .trim();
}

/**
 * Choose the difficulty worth showing: the one the player is still climbing, not one
 * they have already capped. Counting scenarios-touched picks the wrong tier for anyone
 * who ran each Novice scenario twice to max it.
 */
export function pickDifficulty(
  benchmark: BenchmarkDef,
  history: Map<string, ScenarioHistory>,
): DifficultyDef {
  let best = benchmark.difficulties[0];
  let bestRuns = -1;

  for (const difficulty of benchmark.difficulties) {
    const scenarios = difficulty.categories.flatMap((c) => c.scenarios);
    const runs = scenarios.reduce((n, s) => n + (history.get(s.name)?.runs.length ?? 0), 0);

    const scores = new Map<string, number>();
    for (const s of scenarios) {
      const h = history.get(s.name);
      if (h) scores.set(s.name, h.best);
    }
    const maxed =
      evaluateBenchmark(difficulty, scores).rankIndex === difficulty.rankNames.length - 1;

    if (!maxed && runs > bestRuns) {
      best = difficulty;
      bestRuns = runs;
    }
  }
  return best;
}

export function buildSnapshot(options: SnapshotOptions): Snapshot | null {
  const now = options.now ?? new Date();

  const benchmark = JSON.parse(
    readFileSync(options.benchmarkPath ?? dataFile("benchmarks", "voltaic-s5.json"), "utf8"),
  ) as BenchmarkDef;
  const subcats = (
    JSON.parse(readFileSync(dataFile("subcategories.json"), "utf8")) as {
      families: Record<string, { skill: string; subCategory: string }>;
    }
  ).families;
  const theme = loadRankTheme();

  const history = scanStatsFolder(options.statsDir);
  if (history.size === 0) return null;

  const difficulty = pickDifficulty(benchmark, history);

  const scores = new Map<string, number>();
  for (const cat of difficulty.categories) {
    for (const s of cat.scenarios) {
      const h = history.get(s.name);
      if (h) scores.set(s.name, h.best);
    }
  }

  const result = evaluateBenchmark(difficulty, scores);

  // With no live population, tier placement is estimated from benchmark standing and
  // labelled as provisional in the UI. Replaced by a real percentile once the ladder
  // has players.
  const percentile = Math.max(
    0,
    Math.min(
      99.9,
      ((result.rankIndex + 1 + (result.progressToNextRank ?? 0)) /
        (difficulty.rankNames.length + 1)) *
        100,
    ),
  );
  const tier = tierForPercentile(theme, percentile);

  let rating = defaultRating();
  for (let i = 0; i < 12; i++) {
    rating = updateRating(rating, [
      { opponent: { rating: 1500, rd: 90, volatility: 0.06 }, score: i % 3 === 0 ? 0 : 1 },
    ]);
  }

  const categories = result.categories.map((cat) => ({
    name: cat.name,
    energy: Math.round(cat.energy),
    rankName: cat.rankName,
    perScenario: Math.round(cat.energy / Math.max(1, cat.scenarios.length)),
    scenarios: cat.scenarios.map((s) => ({
      name: s.scenario.name,
      label: shortName(s.scenario.name, difficulty.name),
      subCategory: subcats[shortName(s.scenario.name, difficulty.name)]?.subCategory ?? null,
      score: s.score,
      rankName: s.rankName,
      energy: Math.round(s.energy),
      nextRankName: s.nextRankName,
      nextRankScore: s.nextRankScore,
      gap: s.gapToNextRank,
      runs: history.get(s.scenario.name)?.runs.length ?? 0,
    })),
  }));

  const weakest = [...result.categories].sort((a, b) => a.energy - b.energy)[0];

  let nextId = 1;
  const pool: SelectableScenario[] = difficulty.categories.flatMap((cat) =>
    cat.scenarios.map((s) => {
      const family = shortName(s.name, difficulty.name);
      return {
        id: nextId++,
        name: s.name,
        aimType: subcats[family]?.skill ?? cat.name,
        subCategory: subcats[family]?.subCategory ?? null,
      };
    }),
  );

  const seed = "apogee-demo-match-01";
  const chosen = selectScenarios(pool, seed, { category: weakest.name });

  const playerRounds: RoundSubmission[] = [];
  const opponentRounds: RoundSubmission[] = [];

  for (const scenario of chosen) {
    const h = history.get(scenario.name);
    if (!h || h.runs.length === 0) continue;

    const baseline = computeBaseline(h, h.best);
    const latest = h.runs[h.runs.length - 1].score;

    playerRounds.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      score: latest,
      baseline: baseline.value,
      provisional: baseline.provisional,
      verificationTier: "verified",
    });

    const oppBaseline = baseline.value * 0.97;
    const oppDelta = [0.031, -0.012, 0.018][opponentRounds.length % 3];
    opponentRounds.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      score: Math.round(oppBaseline * (1 + oppDelta)),
      baseline: oppBaseline,
      provisional: false,
      verificationTier: "consistent",
    });
  }

  const settlement = settleMatch({ playerRounds, opponentRounds });
  const opponentRating = { rating: rating.rating - 40, rd: 85, volatility: 0.06 };

  const quests = generateQuests({ difficulty, history, now, count: 5 }).map((q) => ({
    title: q.title,
    detail: q.detail,
    xp: q.xp,
    kind: q.kind,
    progress: questProgress(q),
    // Floor quests read differently and are worth marking, so the UI can say what kind
    // of effort is being asked for rather than showing an undifferentiated list.
    isFloor: q.kind === "floor_rank_up" || q.kind === "close_the_spread" ||
      q.kind === "no_disasters",
    // "4 of 5" is more legible on a floor quest than a percentage.
    steps: q.target >= 5 ? { done: Math.round(q.progress), total: q.target } : null,
  }));

  const totalRuns = [...history.values()].reduce((n, h) => n + h.runs.length, 0);

  // ---- consistency: the floor rank, alongside the ceiling everyone else ranks ----
  const scoreHistory = new Map<string, number[]>();
  for (const cat of difficulty.categories) {
    for (const s of cat.scenarios) {
      const h = history.get(s.name);
      if (h) scoreHistory.set(s.name, h.runs.map((r) => r.score));
    }
  }

  const floors = floorsFor(scoreHistory);
  const floorScores = new Map<string, number>();
  for (const [name, f] of floors) floorScores.set(name, f.floor);

  const floorResult = evaluateBenchmark(difficulty, floorScores);

  const consistency = {
    method: "worstOfLast5",
    ceilingRank: result.rankName,
    ceilingEnergy: Math.round(result.totalEnergy),
    floorRank: floorResult.rankName,
    floorEnergy: Math.round(floorResult.totalEnergy),
    gap: overallGap(floors.values()),
    scenarios: [...floors.values()]
      .filter((f) => !f.provisional)
      .sort((a, b) => b.gap - a.gap)
      .map((f) => ({
        name: f.scenario,
        label: shortName(f.scenario, difficulty.name),
        ceiling: f.ceiling,
        floor: f.floor,
        median: f.median,
        gap: f.gap,
      })),
  };

  return {
    generatedAt: now.toISOString(),
    benchmark: {
      name: benchmark.benchmarkName,
      difficulty: difficulty.name,
      rankNames: difficulty.rankNames,
      rankColors: difficulty.rankColors,
    },
    player: {
      totalRuns,
      scenarioCount: history.size,
      streak: playStreak(history, now),
      benchmarkRank: result.rankName,
      benchmarkEnergy: Math.round(result.totalEnergy),
      progressToNextRank: result.progressToNextRank,
      nextRankName: difficulty.rankNames[result.rankIndex + 1] ?? null,
      apogee: {
        rating: Math.round(rating.rating),
        rd: Math.round(rating.rd),
        percentile: Number(percentile.toFixed(1)),
        tier,
      },
    },
    theme: theme.tiers,
    categories,
    weakest: weakest.name,
    consistency,
    match: {
      seed,
      category: weakest.name,
      opponent: {
        name: "ravenous",
        rating: Math.round(opponentRating.rating),
        tier: tierForPercentile(theme, Math.max(0, percentile - 6)),
      },
      winProbability: winProbability(rating, opponentRating),
      verdict: settlement.verdict,
      explanation: explainVerdict(settlement),
      ratingWeight: settlement.ratingWeight,
      playerMatchScore: settlement.player.matchScore,
      opponentMatchScore: settlement.opponent.matchScore,
      rounds: settlement.player.rounds.map((r, i) => ({
        label: shortName(r.scenarioName, difficulty.name),
        you: { score: r.score, baseline: Math.round(r.baseline), delta: r.delta },
        them: {
          score: settlement.opponent.rounds[i]?.score ?? 0,
          baseline: Math.round(settlement.opponent.rounds[i]?.baseline ?? 0),
          delta: settlement.opponent.rounds[i]?.delta ?? 0,
        },
      })),
    },
    quests,
  };
}
