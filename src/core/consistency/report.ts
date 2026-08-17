/**
 * Consistency report: your ceiling rank, your floor rank, and the gap between them.
 *
 * The floor is fed through exactly the same Voltaic energy engine as the ceiling, so
 * "Diamond ceiling, Platinum floor" is not a metaphor. Both are real ranks computed the
 * same way; they differ only in which score goes in.
 *
 *   npx tsx src/core/consistency/report.ts [--method worstOfLast5] [--stats <folder>]
 *   npx tsx src/core/consistency/report.ts --compare
 */

import { readFileSync } from "node:fs";

import { evaluateBenchmark } from "../benchmarks/energy.ts";
import type { BenchmarkDef, DifficultyDef } from "../benchmarks/types.ts";
import { dataFile } from "../dataDir.ts";
import { scanStatsFolder, type ScenarioHistory } from "../history/history.ts";
import { computeFloor, floorsFor, overallGap, type FloorMethod } from "./floor.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function fg(hex: string | undefined): string {
  if (!hex) return "";
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function shortName(scenario: string, difficulty: string): string {
  return scenario
    .replace(/^VT /, "")
    .replace(new RegExp(`\\s*${difficulty.split(" ")[0]}\\s*`, "i"), " ")
    .replace(/\s*S\d(\.\d)?\s*$/i, "")
    .trim();
}

/** The difficulty the player is actually climbing, not one they have capped. */
function pickDifficulty(
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

function main(): void {
  const statsDir = arg("--stats") ?? DEFAULT_STATS_DIR;
  const method = (arg("--method") ?? "worstOfLast5") as FloorMethod;
  const compare = process.argv.includes("--compare");

  const benchmark = JSON.parse(
    readFileSync(dataFile("benchmarks", "voltaic-s5.json"), "utf8"),
  ) as BenchmarkDef;

  const history = scanStatsFolder(statsDir);
  if (history.size === 0) {
    console.error(`no runs in ${statsDir}`);
    process.exit(1);
  }

  const difficulty = pickDifficulty(benchmark, history);
  const scenarios = difficulty.categories.flatMap((c) => c.scenarios);

  const scoreHistory = new Map<string, number[]>();
  for (const s of scenarios) {
    const h = history.get(s.name);
    if (h) scoreHistory.set(s.name, h.runs.map((r) => r.score));
  }

  // ---- comparing definitions ----------------------------------------------------
  if (compare) {
    console.log(`\n${BOLD}How should the floor be defined?${RESET}`);
    console.log(`${DIM}${benchmark.benchmarkName} ${difficulty.name}${RESET}\n`);
    console.log("method            floor rank    energy    mean gap   worst scenario");

    for (const m of ["worstOfLast5", "worstOfLast10", "p20OfLast20", "p10OfLast20"] as FloorMethod[]) {
      const floors = floorsFor(scoreHistory, m);
      const floorScores = new Map<string, number>();
      for (const [name, f] of floors) floorScores.set(name, f.floor);

      const result = evaluateBenchmark(difficulty, floorScores);
      const gap = overallGap(floors.values());
      const worst = [...floors.values()].sort((a, b) => b.gap - a.gap)[0];

      console.log(
        `${m.padEnd(17)} ${(result.rankName ?? "unranked").padEnd(12)} ` +
          `${result.totalEnergy.toFixed(0).padStart(7)}   ${(gap * 100).toFixed(1).padStart(6)}%   ` +
          `${shortName(worst.scenario, difficulty.name)} ${(worst.gap * 100).toFixed(0)}%`,
      );
    }
    console.log(
      `\n${DIM}A harsher method makes a more dramatic stat and a noisier one: a single bad\n` +
        `run moves it a long way. A percentile is steadier but harder to explain.${RESET}\n`,
    );
    return;
  }

  // ---- the report ----------------------------------------------------------------
  const ceilingScores = new Map<string, number>();
  const floorScores = new Map<string, number>();
  const floors = floorsFor(scoreHistory, method);

  for (const s of scenarios) {
    const h = history.get(s.name);
    if (h) ceilingScores.set(s.name, h.best);
    const f = floors.get(s.name);
    if (f) floorScores.set(s.name, f.floor);
  }

  const ceiling = evaluateBenchmark(difficulty, ceilingScores);
  const floor = evaluateBenchmark(difficulty, floorScores);
  const colorOf = (rank: string | null) => fg(rank ? difficulty.rankColors[rank] : undefined);

  console.log();
  console.log(`${BOLD}${benchmark.benchmarkName} — ${difficulty.name}${RESET}`);
  console.log(`${DIM}floor method: ${method}${RESET}\n`);

  console.log(
    `  ceiling   ${colorOf(ceiling.rankName)}${BOLD}${(ceiling.rankName ?? "unranked").padEnd(12)}${RESET}` +
      `${ceiling.totalEnergy.toFixed(0).padStart(8)} energy   ${DIM}what every benchmark ranks you${RESET}`,
  );
  console.log(
    `  floor     ${colorOf(floor.rankName)}${BOLD}${(floor.rankName ?? "unranked").padEnd(12)}${RESET}` +
      `${floor.totalEnergy.toFixed(0).padStart(8)} energy   ${DIM}what you can do reliably${RESET}`,
  );

  const gap = overallGap(floors.values());
  console.log(`\n  ${BOLD}gap ${(gap * 100).toFixed(1)}%${RESET}   ${DIM}lower is better; this is the number to close${RESET}`);

  // ---- per scenario, worst gap first ---------------------------------------------
  console.log(`\n${BOLD}Where you are least reliable${RESET}`);
  const ranked = [...floors.values()]
    .filter((f) => !f.provisional)
    .sort((a, b) => b.gap - a.gap);

  console.log(
    `  ${"scenario".padEnd(16)} ${"ceiling".padStart(8)} ${"floor".padStart(8)} ` +
      `${"gap".padStart(7)}   rank drop`,
  );

  for (const f of ranked.slice(0, 10)) {
    const scenarioDef = scenarios.find((s) => s.name === f.scenario)!;
    const cRank = rankOfScore(scenarioDef.rankMaxes, f.ceiling, difficulty.rankNames);
    const fRank = rankOfScore(scenarioDef.rankMaxes, f.floor, difficulty.rankNames);
    const drop = cRank === fRank ? `${DIM}none${RESET}` :
      `${colorOf(cRank)}${cRank ?? "—"}${RESET} ${DIM}→${RESET} ${colorOf(fRank)}${fRank ?? "unranked"}${RESET}`;

    console.log(
      `  ${shortName(f.scenario, difficulty.name).padEnd(16)} ` +
        `${f.ceiling.toFixed(0).padStart(8)} ${f.floor.toFixed(0).padStart(8)} ` +
        `${(f.gap * 100).toFixed(1).padStart(6)}%   ${drop}`,
    );
  }

  const steady = ranked.slice(-3).reverse();
  if (steady.length > 0) {
    console.log(`\n${BOLD}Most reliable${RESET}`);
    for (const f of steady) {
      console.log(
        `  ${shortName(f.scenario, difficulty.name).padEnd(16)} ` +
          `${f.ceiling.toFixed(0).padStart(8)} ${f.floor.toFixed(0).padStart(8)} ` +
          `${(f.gap * 100).toFixed(1).padStart(6)}%`,
      );
    }
  }
  console.log();
}

/** Rank name a score would earn on one scenario, or null if below the first threshold. */
function rankOfScore(
  rankMaxes: number[],
  score: number,
  rankNames: string[],
): string | null {
  let idx = -1;
  for (let i = 0; i < rankMaxes.length; i++) {
    if (score >= rankMaxes[i]) idx = i;
    else break;
  }
  return idx >= 0 ? (rankNames[idx] ?? null) : null;
}

main();
