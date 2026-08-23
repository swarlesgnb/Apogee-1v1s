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
import { hasSeason, loadSeason, seasonAsDifficulty, seasonLabels } from "../season/season.ts";
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

  // The season decides what a rank means (PLAN.md §14); the benchmark file is only a
  // fallback for an install that has no season yet.
  const season = hasSeason() ? loadSeason() : null;
  const benchmark = season
    ? null
    : (JSON.parse(
        readFileSync(dataFile("benchmarks", "voltaic-s5.json"), "utf8"),
      ) as BenchmarkDef);

  const history = scanStatsFolder(statsDir);
  if (history.size === 0) {
    console.error(`no runs in ${statsDir}`);
    process.exit(1);
  }

  const difficulty = season
    ? seasonAsDifficulty(season)
    : pickDifficulty(benchmark!, history);

  // What to call the thing being measured against, whichever it is.
  const definitionName = season ? season.name : `${benchmark!.benchmarkName} ${difficulty.name}`;
  const scenarios = difficulty.categories.flatMap((c) => c.scenarios);

  // A season carries its own labels. Deriving them from the definition name works for a
  // benchmark, where the name is the difficulty being stripped, and not for a season,
  // where it is "Season 1" and every label keeps the difficulty it was seeded from.
  const seasonLabel = season ? seasonLabels(season) : null;

  // Three variants of one family share a label - all three of these are "Pasu" - and
  // this report has a row per scenario, not per family, because reliability on the
  // Novice one is a different fact from reliability on the Advanced one. So the window
  // is part of the name here, where three identical rows would otherwise appear.
  const windowOf = new Map<string, string>();
  if (season?.windows) {
    for (const scen of season.scenarios) {
      const name = season.windows[scen.window ?? 0];
      if (name) windowOf.set(scen.scenario, name);
    }
  }

  const labelFor = (name: string) => {
    const base = seasonLabel?.get(name) ?? shortName(name, difficulty.name);
    const window = windowOf.get(name);
    return window ? `${base} ${window.slice(0, 3).toLowerCase()}` : base;
  };

  // Which category's ladder a scenario is graded against, and how far into it its own
  // thresholds start. On a windowed season a variant covers four ranks partway up a
  // ladder of twelve, so reading its thresholds against index 0 names the wrong rank.
  const ladderFor = new Map<string, { rankNames: string[]; offset: number }>();
  for (const c of difficulty.categories) {
    for (const scen of c.scenarios) {
      ladderFor.set(scen.name, {
        rankNames: c.rankNames ?? difficulty.rankNames,
        offset: (scen.window ?? 0) * (c.windowSize ?? 0),
      });
    }
  }

  const scoreHistory = new Map<string, number[]>();
  for (const s of scenarios) {
    const h = history.get(s.name);
    if (h) scoreHistory.set(s.name, h.runs.map((r) => r.score));
  }

  // ---- comparing definitions ----------------------------------------------------
  if (compare) {
    console.log(`\n${BOLD}How should the floor be defined?${RESET}`);
    console.log(`${DIM}${definitionName}${RESET}\n`);
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
          `${labelFor(worst.scenario)} ${(worst.gap * 100).toFixed(0)}%`,
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
  console.log(`${BOLD}${definitionName}${RESET}`);
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
    `  ${"scenario".padEnd(20)} ${"ceiling".padStart(8)} ${"floor".padStart(8)} ` +
      `${"gap".padStart(7)}   rank drop`,
  );

  for (const f of ranked.slice(0, 10)) {
    const scenarioDef = scenarios.find((s) => s.name === f.scenario)!;
    const ladder = ladderFor.get(f.scenario)!;
    const cRank = rankOfScore(scenarioDef.rankMaxes, f.ceiling, ladder.rankNames, ladder.offset);
    const fRank = rankOfScore(scenarioDef.rankMaxes, f.floor, ladder.rankNames, ladder.offset);
    const drop = cRank === fRank ? `${DIM}none${RESET}` :
      `${colorOf(cRank)}${cRank ?? "—"}${RESET} ${DIM}→${RESET} ${colorOf(fRank)}${fRank ?? "unranked"}${RESET}`;

    console.log(
      `  ${labelFor(f.scenario).padEnd(20)} ` +
        `${f.ceiling.toFixed(0).padStart(8)} ${f.floor.toFixed(0).padStart(8)} ` +
        `${(f.gap * 100).toFixed(1).padStart(6)}%   ${drop}`,
    );
  }

  const steady = ranked.slice(-3).reverse();
  if (steady.length > 0) {
    console.log(`\n${BOLD}Most reliable${RESET}`);
    for (const f of steady) {
      console.log(
        `  ${labelFor(f.scenario).padEnd(20)} ` +
          `${f.ceiling.toFixed(0).padStart(8)} ${f.floor.toFixed(0).padStart(8)} ` +
          `${(f.gap * 100).toFixed(1).padStart(6)}%`,
      );
    }
  }
  console.log();
}

/**
 * Rank name a score would earn on one scenario, or null if below the first threshold.
 *
 * `offset` is how many ranks sit below this scenario's window. Zero on a flat ladder.
 */
function rankOfScore(
  rankMaxes: number[],
  score: number,
  rankNames: string[],
  offset = 0,
): string | null {
  let idx = -1;
  for (let i = 0; i < rankMaxes.length; i++) {
    if (score >= rankMaxes[i]) idx = i;
    else break;
  }
  return idx >= 0 ? (rankNames[idx + offset] ?? null) : null;
}

main();
