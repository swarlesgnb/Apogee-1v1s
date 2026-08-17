/**
 * Derive per-scenario scoring relations from a corpus of runs.
 *
 * Most KovaaK's scenarios score as a fixed multiple of a countable stat (kills, hits,
 * or damage) and that multiple is a property of the scenario, not the player. Learning
 * it lets us re-derive the score from the run's own counters, which is the only local
 * defence against the simplest attack there is: editing `Score:` and nothing else.
 *
 * The relation is a fact about the scenario, so the output is reference data and is
 * committed. Rebuild it as new scenarios appear:
 *
 *   npx tsx src/core/verify/buildScoreModels.ts [statsFolder]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseStatsFile, type ParsedRun } from "../stats/parseStatsFile.ts";
import type { ScoreModel } from "./consistency.ts";

const DEFAULT_STATS_DIR =
  "E:\\Steam\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats";

const OUT = new URL("../../../data/score_models.json", import.meta.url);

/** Runs needed before a relation is trusted. Higher is safer; 8 is already strong. */
const MIN_RUNS = 8;

/** Relative agreement required across every run for a relation to count as constant. */
const TOLERANCE = 0.001;

const STATS: { name: ScoreModel["stat"]; get: (r: ParsedRun) => number | null }[] = [
  { name: "kills", get: (r) => r.kills },
  { name: "hitCount", get: (r) => r.hitCount },
  { name: "damageDone", get: (r) => r.damageDone },
];

export function deriveModel(runs: ParsedRun[]): ScoreModel | null {
  for (const { name, get } of STATS) {
    const ratios: number[] = [];

    for (const run of runs) {
      const value = get(run);
      // A zero stat says nothing about the multiplier either way.
      if (value == null || value === 0) continue;
      ratios.push(run.score / value);
    }

    if (ratios.length < MIN_RUNS) continue;

    const first = ratios[0];
    if (!Number.isFinite(first) || first === 0) continue;

    const constant = ratios.every(
      (r) => Math.abs(r - first) / Math.abs(first) <= TOLERANCE,
    );
    if (!constant) continue;

    // Snap to a clean value where the relation is obviously an integer or simple
    // fraction; float noise in damage-based scoring otherwise leaves 9.999999994.
    const rounded = Math.round(first * 1000) / 1000;
    return { stat: name, k: Math.abs(rounded - Math.round(rounded)) < 1e-6 ? Math.round(rounded) : rounded };
  }
  return null;
}

function main(): void {
  const dir = process.argv[2] ?? DEFAULT_STATS_DIR;

  const byScenario = new Map<string, ParsedRun[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith("Stats.csv"))) {
    try {
      const result = parseStatsFile(file, readFileSync(join(dir, file), "utf8"));
      if (!result.ok) continue;
      const list = byScenario.get(result.run.scenario) ?? [];
      list.push(result.run);
      byScenario.set(result.run.scenario, list);
    } catch {
      /* parser is validated separately */
    }
  }

  const models: Record<string, ScoreModel> = {};
  let considered = 0;
  let skippedThin = 0;

  for (const [scenario, runs] of [...byScenario].sort()) {
    if (runs.length < MIN_RUNS) {
      skippedThin++;
      continue;
    }
    considered++;
    const model = deriveModel(runs);
    if (model) models[scenario] = model;
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        $comment: [
          "Learned scoring relations: score = <stat> * k, per scenario.",
          "Derived from observed runs, not from documentation. A scenario only appears",
          "here if the relation held across every observed run with no exceptions.",
          "Used by the score_matches_model integrity check; scenarios absent from this",
          "file simply skip that check rather than failing it.",
          "Rebuild with: npx tsx src/core/verify/buildScoreModels.ts",
        ],
        minRuns: MIN_RUNS,
        tolerance: TOLERANCE,
        derivedFrom: `${byScenario.size} scenarios`,
        models,
      },
      null,
      2,
    ),
    "utf8",
  );

  const byStat = new Map<string, number>();
  for (const m of Object.values(models)) {
    byStat.set(m.stat, (byStat.get(m.stat) ?? 0) + 1);
  }

  console.log(`scenarios seen        : ${byScenario.size}`);
  console.log(`too few runs (<${MIN_RUNS})   : ${skippedThin}`);
  console.log(`considered            : ${considered}`);
  console.log(`models derived        : ${Object.keys(models).length}` +
    ` (${((Object.keys(models).length / considered) * 100).toFixed(1)}%)`);
  console.log(`  by stat             : ${[...byStat].map(([s, n]) => `${s}=${n}`).join("  ")}`);
  console.log(`\nwrote data/score_models.json`);
}

main();
