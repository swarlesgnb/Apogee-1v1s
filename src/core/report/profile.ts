/**
 * Local profile report: benchmark ranks, weakness map and baselines, computed entirely
 * from the stats folder with no backend and no account.
 *
 * This is Phase 2's deliverable and the app's onboarding moment: everything here is
 * derived from files already on disk, so a new user sees their real standing seconds
 * after installing, having entered nothing.
 *
 *   npx tsx src/core/report/profile.ts [--benchmark <slug>] [--difficulty <name>]
 *                                      [--stats <folder>]
 */

import { readFileSync } from "node:fs";

import { evaluateBenchmark, type ScenarioResult } from "../benchmarks/energy.ts";
import type { BenchmarkDef, DifficultyDef } from "../benchmarks/types.ts";
import { computeBaseline, scanStatsFolder, type ScenarioHistory } from "../history/history.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/** Truecolor escape from a #rrggbb string; falls back to no colour. */
function fg(hex: string | undefined): string {
  if (!hex) return "";
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function bar(fraction: number, width = 28): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + DIM + "░".repeat(width - filled) + RESET;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** "VT Frogtagon Intermediate S5" -> "Frogtagon", given the difficulty in context. */
function shortName(scenario: string, difficultyName: string): string {
  return scenario
    .replace(/^VT /, "")
    .replace(new RegExp(`\\s*${difficultyName}\\s*`, "i"), " ")
    .replace(/\s*S5(\.5)?\s*$/i, "")
    .trim();
}

/**
 * Pick the difficulty worth showing.
 *
 * Counting scenarios-touched picks the wrong one: a player who ran each Novice
 * scenario twice to cap it looks "complete" there, but the difficulty they actually
 * care about is the one they are still climbing. So prefer difficulties the player has
 * not maxed out, and among those, the one with the most runs.
 */
function chooseDifficulty(
  benchmark: BenchmarkDef,
  history: Map<string, ScenarioHistory>,
): DifficultyDef {
  interface Candidate {
    difficulty: DifficultyDef;
    runs: number;
    maxed: boolean;
    official: boolean;
  }

  const candidates: Candidate[] = benchmark.difficulties.map((difficulty) => {
    const scenarios = difficulty.categories.flatMap((c) => c.scenarios);

    const runs = scenarios.reduce(
      (n, s) => n + (history.get(s.name)?.runs.length ?? 0),
      0,
    );

    const scores = new Map<string, number>();
    for (const s of scenarios) {
      const h = history.get(s.name);
      if (h) scores.set(s.name, h.best);
    }
    const result = evaluateBenchmark(difficulty, scores);
    const maxed = result.rankIndex === difficulty.rankNames.length - 1;

    return {
      difficulty,
      runs,
      maxed,
      // "Elite (Unofficial)" reuses the Advanced scenarios, so it ties on runs;
      // prefer the official difficulty when everything else is equal.
      official: !/unofficial/i.test(difficulty.name),
    };
  });

  const played = candidates.filter((c) => c.runs > 0);
  if (played.length === 0) return benchmark.difficulties[0];

  const pool = played.some((c) => !c.maxed) ? played.filter((c) => !c.maxed) : played;

  pool.sort((a, b) => {
    if (a.runs !== b.runs) return b.runs - a.runs;
    if (a.official !== b.official) return a.official ? -1 : 1;
    return 0;
  });

  return pool[0].difficulty;
}

function main(): void {
  const slug = arg("--benchmark") ?? "voltaic-s5";
  const statsDir = arg("--stats") ?? DEFAULT_STATS_DIR;

  const benchmark = JSON.parse(
    readFileSync(new URL(`../../../data/benchmarks/${slug}.json`, import.meta.url), "utf8"),
  ) as BenchmarkDef;

  const history = scanStatsFolder(statsDir);
  if (history.size === 0) {
    console.error(`No runs found in ${statsDir}`);
    process.exit(1);
  }

  const wantedDifficulty = arg("--difficulty");
  const difficulty = wantedDifficulty
    ? (benchmark.difficulties.find(
        (d) => d.name.toLowerCase() === wantedDifficulty.toLowerCase(),
      ) ?? chooseDifficulty(benchmark, history))
    : chooseDifficulty(benchmark, history);

  const scores = new Map<string, number>();
  for (const cat of difficulty.categories) {
    for (const scen of cat.scenarios) {
      const h = history.get(scen.name);
      if (h) scores.set(scen.name, h.best);
    }
  }

  const result = evaluateBenchmark(difficulty, scores);
  const colorOf = (rank: string | null) => fg(rank ? difficulty.rankColors[rank] : undefined);

  const totalRuns = [...history.values()].reduce((n, h) => n + h.runs.length, 0);

  console.log();
  console.log(`${BOLD}${benchmark.benchmarkName} ${difficulty.name}${RESET}`);
  console.log(
    `${DIM}${totalRuns.toLocaleString()} runs across ${history.size} scenarios${RESET}`,
  );
  console.log();

  const rankLabel = result.rankName ?? "Unranked";
  console.log(
    `  ${BOLD}${colorOf(result.rankName)}${rankLabel}${RESET}` +
      `   ${result.totalEnergy.toFixed(0)} energy`,
  );
  if (result.progressToNextRank != null) {
    const nextName = difficulty.rankNames[result.rankIndex + 1] ?? "next";
    console.log(
      `  ${bar(result.progressToNextRank)} ` +
        `${(result.progressToNextRank * 100).toFixed(0)}% to ${colorOf(nextName)}${nextName}${RESET}`,
    );
  }
  console.log();

  // ---- weakness map -------------------------------------------------------------
  console.log(`${BOLD}Weakness map${RESET}  ${DIM}(category energy, max 10000/scenario)${RESET}`);
  const maxCatEnergy = Math.max(...result.categories.map((c) => c.energy), 1);

  for (const cat of result.categories) {
    const perScenario = cat.energy / Math.max(1, cat.scenarios.length);
    console.log(
      `  ${cat.name.padEnd(10)} ${bar(cat.energy / maxCatEnergy, 24)} ` +
        `${cat.energy.toFixed(0).padStart(7)}  ` +
        `${colorOf(cat.rankName)}${(cat.rankName ?? "unranked").padEnd(12)}${RESET}` +
        `${DIM}avg ${perScenario.toFixed(0)}/scen${RESET}`,
    );
  }
  console.log();

  // ---- per-scenario detail ------------------------------------------------------
  console.log(`${BOLD}Scenarios${RESET}`);
  for (const cat of result.categories) {
    console.log(`  ${DIM}${cat.name}${RESET}`);
    const sorted = [...cat.scenarios].sort((a, b) => a.energy - b.energy);

    for (const s of sorted) {
      const h = history.get(s.scenario.name);
      const runs = h?.runs.length ?? 0;
      const label = shortName(s.scenario.name, difficulty.name);

      const gap =
        s.gapToNextRank != null && s.nextRankName
          ? `${DIM}+${s.gapToNextRank.toFixed(0)} → ${RESET}${colorOf(s.nextRankName)}${s.nextRankName}${RESET}`
          : `${DIM}max rank${RESET}`;

      console.log(
        `    ${label.padEnd(18)} ` +
          `${s.score > 0 ? s.score.toFixed(0).padStart(7) : DIM + "—".padStart(7) + RESET} ` +
          `${colorOf(s.rankName)}${(s.rankName ?? "—").padEnd(12)}${RESET}` +
          `${s.energy.toFixed(0).padStart(6)}e  ` +
          `${DIM}${runs.toString().padStart(4)} runs${RESET}  ${gap}`,
      );
    }
  }
  console.log();

  // ---- closest rank-ups: the actionable part -----------------------------------
  const candidates: ScenarioResult[] = result.categories
    .flatMap((c) => c.scenarios)
    .filter((s) => s.score > 0 && s.gapToNextRank != null && s.nextRankName != null);

  // Rank by relative gap, so "20 points on a 3000-point scenario" beats
  // "20 points on a 500-point scenario".
  candidates.sort((a, b) => a.gapToNextRank! / a.score - b.gapToNextRank! / b.score);

  console.log(`${BOLD}Closest rank-ups${RESET}  ${DIM}(smallest relative gap first)${RESET}`);
  if (candidates.length === 0) {
    console.log(`  ${DIM}every played scenario is already at max rank${RESET}`);
  }
  for (const s of candidates.slice(0, 6)) {
    const pctGap = (s.gapToNextRank! / s.score) * 100;
    const label = shortName(s.scenario.name, difficulty.name);
    console.log(
      `  ${label.padEnd(20)} ${s.score.toFixed(0).padStart(7)} → ` +
        `${s.nextRankScore!.toFixed(0).padStart(7)}  ` +
        `${DIM}+${s.gapToNextRank!.toFixed(0)} (${pctGap.toFixed(1)}%)${RESET}  ` +
        `${colorOf(s.nextRankName)}${s.nextRankName}${RESET}`,
    );
  }
  console.log();

  // ---- baselines ----------------------------------------------------------------
  console.log(`${BOLD}Match baselines${RESET}  ${DIM}(what a 1v1 would score you against)${RESET}`);
  const withHistory = result.categories
    .flatMap((c) => c.scenarios)
    .filter((s) => (history.get(s.scenario.name)?.runs.length ?? 0) > 0)
    .slice(0, 8);

  for (const s of withHistory) {
    const h = history.get(s.scenario.name);
    const baseline = computeBaseline(h, s.score);
    const label = shortName(s.scenario.name, difficulty.name);
    const flags = [
      baseline.provisional ? "provisional" : "",
      baseline.flooredByPb ? "pb-floored" : "",
    ]
      .filter(Boolean)
      .join(" ");

    console.log(
      `  ${label.padEnd(20)} baseline ${baseline.value.toFixed(0).padStart(7)}  ` +
        `${DIM}best ${s.score.toFixed(0)}  ${baseline.runCount} runs ${flags}${RESET}`,
    );
  }
  console.log();
}

main();
