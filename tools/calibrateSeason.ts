/**
 * Write data/season-1/calibration.json from this machine's KovaaK's runs.
 *
 *   npm run calibrate:season [-- --stats <stats folder>] [--dry]
 *
 * Then npm run build:season applies it. The method, and why one player is enough to say
 * which families the model mispriced, is in src/core/season/calibration.ts.
 *
 * Only runs whose Hash matches the MD5 of the committed scenario file are read, so a run on
 * an earlier build of a scenario never moves the current one. What each family was moved
 * by, and on which runs, is written beside the factor.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { calibrate, CLAMP, DEADBAND, MIN_FAMILIES, type Calibration, type CalibrationInput } from "../src/core/season/calibration.ts";
import { parseFilename, parseStatsFile } from "../src/core/stats/parseStatsFile.ts";
import type { Season, SeasonScenario } from "../src/core/season/season.ts";
import { kovaaksRoot } from "./scenarioCorpus.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const statsArg = args.indexOf("--stats");
const root = kovaaksRoot();
const statsDir = statsArg >= 0 ? args[statsArg + 1] : root ? join(root, "stats") : null;
if (!statsDir || !existsSync(statsDir)) {
  console.error("No KovaaK's stats folder found. Pass --stats <...\\FPSAimTrainer\\FPSAimTrainer\\stats>.");
  process.exit(1);
}

type Row = SeasonScenario & { source?: { kind?: string; predicted?: number[] } };
const season = JSON.parse(readFileSync(dataFile("seasons", "season-1.json"), "utf8")) as Season & { scenarios: Row[] };

const sceDir = dataFile("season-1", "scenarios");
const hashOf = new Map<string, string>();
for (const s of season.scenarios) {
  const file = join(sceDir, `${s.scenario}.sce`);
  if (existsSync(file)) hashOf.set(s.scenario, createHash("md5").update(readFileSync(file)).digest("hex"));
}

const best = new Map<string, { best: number; runs: number }>();
let read = 0;
let stale = 0;
for (const name of readdirSync(statsDir)) {
  const info = parseFilename(name);
  if (!info || !hashOf.has(info.scenario)) continue;
  const parsed = parseStatsFile(name, readFileSync(join(statsDir, name), "utf8"));
  if (!parsed.ok) continue;
  const { scenario, score, hash } = parsed.run;
  if (hashOf.get(scenario) !== hash) {
    stale++;
    continue;
  }
  read++;
  const was = best.get(scenario);
  best.set(scenario, { best: Math.max(was?.best ?? -Infinity, score), runs: (was?.runs ?? 0) + 1 });
}

const inputs: CalibrationInput[] = [];
for (const s of season.scenarios) {
  const b = best.get(s.scenario);
  if (!b) continue;
  // The uncalibrated prediction, so calibrating twice never compounds.
  const predicted = s.source?.kind === "calibrated" ? s.source.predicted : s.source?.kind === "predicted" ? s.rankMaxes : undefined;
  if (!predicted) continue; // a row recut from a real board is not the model's to correct
  inputs.push({ scenario: s.scenario, category: s.category, family: s.family!, window: s.window ?? 0, predicted, best: b.best, runs: b.runs });
}

const families = calibrate(inputs);
const out: Calibration = {
  about:
    "Per-family corrections to the predicted thresholds, measured by npm run calibrate:season on one player's runs and applied by build:season. See src/core/season/calibration.ts.",
  builtAt: new Date().toISOString(),
  rules: { minFamilies: MIN_FAMILIES, clamp: CLAMP, deadband: DEADBAND },
  families,
};

console.log(`${read} runs on the current files, ${stale} on earlier builds (not used), ${inputs.length} scenarios with runs`);
const moved = Object.entries(families).sort((a, b) => Math.abs(Math.log(b[1].factor)) - Math.abs(Math.log(a[1].factor)));
for (const [family, f] of moved) {
  const where = f.evidence.map((e) => `${e.scenario.replace(/^Apogee /, "")} ${e.best} at ${e.position} (target ${e.target})`).join("; ");
  console.log(`  ${family.padEnd(16)} x${f.factor.toFixed(3)}  (raw ${f.raw.toFixed(3)}, ${f.runs} runs)  ${where}`);
}
if (!dry) {
  writeFileSync(dataFile("season-1", "calibration.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log("wrote data/season-1/calibration.json; npm run build:season applies it");
}
