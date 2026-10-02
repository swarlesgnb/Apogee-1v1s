/**
 * Write data/season-1/calibration.json from this machine's KovaaK's runs.
 *
 *   npm run calibrate:season [-- --stats <stats folder>] [--dry] [--keep-anchors]
 *
 * --keep-anchors carries each category's anchor from the calibration.json already written
 * instead of measuring it again, so a round can move families and bands against each other
 * without moving where a whole category sits. The first per-band round needed it: the same
 * runs re-measured Reactive Tracking's anchor from x1.175 to x1.262, which raised every
 * Reactive threshold by 7% in the round meant to fix Intermediate being out of reach.
 *
 * Then npm run build:season applies it. Two corrections, both in
 * src/core/season/calibration.ts, multiplied per family and band:
 *
 *   relative   each family and band against the rest of its category, read on the season's
 *              one ladder across bands, from the player's Apogee bests alone
 *   anchor     each category's ladder moved so the player's practised Apogee best lands
 *              at their top fraction on the real KovaaK's boards of that category's
 *              scenarios (data/leaderboard_percentiles.json, categories from
 *              data/scenario_identity.json)
 *
 * Only Apogee runs whose Hash matches the MD5 of the committed scenario file are read, so a
 * run on an earlier build never moves the current one. Everything each factor was measured
 * on is written beside it.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import {
  anchor,
  ANCHOR_CLAMP,
  calibrate,
  CLAMP,
  COMBINED_CLAMP,
  DEADBAND,
  MIN_FAMILIES,
  PRACTICE_MIN_SCENARIOS,
  topFractionOn,
  type Calibration,
  type CalibrationInput,
  type CategoryAnchor,
  type FamilyCalibration,
} from "../src/core/season/calibration.ts";
import { windowRankIndices } from "../src/core/season/windows.ts";
import { parseFilename, parseStatsFile } from "../src/core/stats/parseStatsFile.ts";
import type { Season, SeasonScenario } from "../src/core/season/season.ts";
import { kovaaksRoot } from "./scenarioCorpus.ts";

/** A real scenario counts toward a category's standing from this many runs. */
const MIN_REAL_RUNS = 3;
/** No single real scenario outweighs this many runs' worth of the others. */
const RUN_WEIGHT_CAP = 30;
/** Practice gain is read on scenarios first played this recently, with this many runs. */
const PRACTICE_WINDOW_DAYS = 90;
const PRACTICE_MIN_RUNS = 10;

/**
 * A family's relative correction set by hand, for a family the runs cannot speak for yet.
 * Written into calibration.json with its reason, and dropped by deleting it here once
 * there are runs on the current file.
 */
const OVERRIDES: Record<string, { relative: number; why: string }> = {
  skeeTS: {
    relative: 0.6,
    why:
      "No runs on the current file: all four playtest runs (1315, 1379, 1405, 1400) carry hash 69ca2fe9 where the " +
      "file is a487161c, though the committed file has not changed since before them. They sat at the first of six " +
      "ranks on Novice while every other Evasive Novice family was fourth or better, and the player could not pass the " +
      "first rank near their ceiling. Read the same way as any family, that is a relative 0.51, held here at the 0.6 floor.",
  },
};

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const keepAnchors = args.includes("--keep-anchors");
const previousCalibration = existsSync(dataFile("season-1", "calibration.json"))
  ? (JSON.parse(readFileSync(dataFile("season-1", "calibration.json"), "utf8")) as Calibration)
  : null;
const statsArg = args.indexOf("--stats");
const root = kovaaksRoot();
const statsDir = statsArg >= 0 ? args[statsArg + 1] : root ? join(root, "stats") : null;
if (!statsDir || !existsSync(statsDir)) {
  console.error("No KovaaK's stats folder found. Pass --stats <...\\FPSAimTrainer\\FPSAimTrainer\\stats>.");
  process.exit(1);
}

type Row = SeasonScenario & { source?: { kind?: string; predicted?: number[] } };
const season = JSON.parse(readFileSync(dataFile("seasons", "season-1.json"), "utf8")) as Season & { scenarios: Row[] };
const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as { windowSize: number; ladder: { ranks: number[]; overlap: number } };
const identity = (JSON.parse(readFileSync(dataFile("scenario_identity.json"), "utf8")) as { scenarios: Record<string, { subCategory?: string }> }).scenarios;
const boards = new Map(
  (JSON.parse(readFileSync(dataFile("leaderboard_percentiles.json"), "utf8")) as { distributions: Array<{ scenario: string; points: Array<{ topFraction: number; score: number }> }> })
    .distributions.map((d) => [d.scenario, d.points]),
);

const sceDir = dataFile("season-1", "scenarios");
const hashOf = new Map<string, string>();
for (const s of season.scenarios) {
  const file = join(sceDir, `${s.scenario}.sce`);
  if (existsSync(file)) hashOf.set(s.scenario, createHash("md5").update(readFileSync(file)).digest("hex"));
}

// ---- read every run --------------------------------------------------------------------

const apogee = new Map<string, { best: number; runs: number }>();
const real = new Map<string, Array<{ at: Date; score: number }>>();
let read = 0;
let stale = 0;
for (const name of readdirSync(statsDir)) {
  const info = parseFilename(name);
  if (!info) continue;
  const parsed = parseStatsFile(name, readFileSync(join(statsDir, name), "utf8"));
  if (!parsed.ok) continue;
  const { scenario, score, hash } = parsed.run;
  if (hashOf.has(scenario)) {
    if (hashOf.get(scenario) !== hash) {
      stale++;
      continue;
    }
    read++;
    const was = apogee.get(scenario);
    apogee.set(scenario, { best: Math.max(was?.best ?? -Infinity, score), runs: (was?.runs ?? 0) + 1 });
  } else if (!scenario.startsWith("Apogee ")) {
    real.set(scenario, [...(real.get(scenario) ?? []), { at: info.playedAt, score }]);
  }
}

// ---- relative ----------------------------------------------------------------------------

const predictedOf = (s: Row) =>
  s.source?.kind === "calibrated" ? s.source.predicted : s.source?.kind === "predicted" ? s.rankMaxes : undefined;

const inputs: CalibrationInput[] = [];
for (const s of season.scenarios) {
  const b = apogee.get(s.scenario);
  const predicted = predictedOf(s);
  if (!b || !predicted) continue; // a row recut from a real board is not the model's to correct
  const window = s.window ?? 0;
  const offset = windowRankIndices(window, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap)[0];
  inputs.push({ scenario: s.scenario, category: s.category, family: s.family!, window, offset, predicted, best: b.best, runs: b.runs });
}
const relative = calibrate(inputs);

// ---- anchor ------------------------------------------------------------------------------

const cutoff = new Date(Date.now() - PRACTICE_WINDOW_DAYS * 864e5);
function practiceRatios(category: string | null): number[] {
  const out: number[] = [];
  for (const [name, runs] of real) {
    if (category && identity[name]?.subCategory !== category) continue;
    if (!category && !identity[name]?.subCategory) continue;
    if (runs.length < PRACTICE_MIN_RUNS) continue;
    const sorted = [...runs].sort((a, b) => a.at.getTime() - b.at.getTime());
    if (sorted[0].at < cutoff) continue;
    const first = Math.max(sorted[0].score, sorted[1].score);
    const best = Math.max(...sorted.map((r) => r.score));
    if (first > 0) out.push(best / first);
  }
  return out.sort((a, b) => a - b);
}
const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : 1);
const pooled = practiceRatios(null);

const ladder = pool.ladder.ranks;
const categories: Record<string, CategoryAnchor> = {};
for (const category of season.categories.map((c) => c.name)) {
  const played = [...real].filter(([n, r]) => identity[n]?.subCategory === category && boards.has(n) && r.length >= MIN_REAL_RUNS);
  const weights = played.map(([, r]) => Math.min(RUN_WEIGHT_CAP, r.length));
  const logs = played.map(([n, r]) => Math.log(topFractionOn(boards.get(n)!, Math.max(...r.map((x) => x.score)))));
  const realTopFraction = played.length ? Math.exp(logs.reduce((s, l, i) => s + weights[i] * l, 0) / weights.reduce((a, b) => a + b, 0)) : 1;
  const own = practiceRatios(category);
  const fromCategory = own.length >= PRACTICE_MIN_SCENARIOS;
  const kept = previousCalibration?.categories?.[category];
  if (keepAnchors) {
    if (!kept) throw new Error(`--keep-anchors: calibration.json has no anchor for ${category}`);
    categories[category] = kept;
    continue;
  }
  categories[category] = anchor({
    category,
    realTopFraction,
    boards: played.length,
    practice: fromCategory ? median(own) : median(pooled),
    practiceScenarios: fromCategory ? own.length : pooled.length,
    practiceFrom: fromCategory ? "category" : "pooled",
    scenarios: season.scenarios
      .filter((s) => s.category === category && apogee.has(s.scenario) && predictedOf(s))
      .map((s) => ({
        scenario: s.scenario,
        best: apogee.get(s.scenario)!.best,
        predicted: predictedOf(s)!,
        topFractions: windowRankIndices(s.window ?? 0, pool.windowSize, ladder.length, pool.ladder.overlap).map((i) => ladder[i]).slice(0, s.rankMaxes.length),
      })),
  });
}

// ---- combined ----------------------------------------------------------------------------

const families: Record<string, FamilyCalibration> = {};
for (const s of season.scenarios) {
  const family = s.family!;
  if (families[family]) continue;
  const rel = relative[family];
  const override = rel ? undefined : OVERRIDES[family];
  const relFactor = override?.relative ?? rel?.factor ?? 1;
  const cat = categories[s.category]?.factor ?? 1;
  const combine = (r: number) => Math.round(Math.min(COMBINED_CLAMP[1], Math.max(COMBINED_CLAMP[0], r * cat)) * 10000) / 10000;
  const combined = combine(relFactor);
  if (combined === 1 && !rel) continue;
  // A band with runs of its own gets its own relative correction, times the same anchor.
  const windows = rel?.windows
    ? Object.fromEntries(Object.entries(rel.windows).map(([w, b]) => [w, { factor: combine(b.factor), relative: b.factor, raw: b.raw, runs: b.runs }]))
    : undefined;
  families[family] = {
    factor: combined,
    relative: relFactor,
    ...(override ? { override: override.why } : {}),
    category: cat,
    raw: rel?.raw ?? 1,
    runs: rel?.runs ?? 0,
    evidence: rel?.evidence ?? [],
    ...(windows ? { windows } : {}),
  };
}

// Explicit per-band playtest tuning is authoritative until its override is removed.
// Recalibrating unrelated families must not quietly restore a known difficulty cliff.
for (const [family, previous] of Object.entries(previousCalibration?.families ?? {})) {
  if (!season.scenarios.some(s => s.family === family)) continue;
  for (const [window, band] of Object.entries(previous.windows ?? {})) {
    if (band.override) {
      families[family] ??= { ...previous, windows: {} };
      (families[family].windows ??= {})[window] = band;
    }
  }
}

const out: Calibration = {
  about:
    "Per-family and per-band corrections to predicted thresholds, measured by npm run calibrate:season and applied by build:season. Explicit per-band overrides retain manual playtest tuning until removed. Otherwise a band's factor is its relative correction times its category anchor, and an unplayed band takes its family's factor. See src/core/season/calibration.ts.",
  builtAt: new Date().toISOString(),
  rules: { minFamilies: MIN_FAMILIES, clamp: CLAMP, deadband: DEADBAND, anchorClamp: ANCHOR_CLAMP, combinedClamp: COMBINED_CLAMP },
  categories,
  families,
};

console.log(`${read} Apogee runs on the current files, ${stale} on earlier builds (not used); ${real.size} other scenarios; pooled practice x${median(pooled).toFixed(3)} over ${pooled.length}`);
for (const [c, a] of Object.entries(categories)) {
  console.log(
    `  ${c.padEnd(18)} anchor x${a.factor.toFixed(3)}${a.held ? ` (held: ${a.held})` : ""}  real top ${(a.realTopFraction * 100).toFixed(1)}% over ${a.boards} boards, ` +
      `practice x${a.practice.toFixed(3)} (${a.practiceFrom}, ${a.practiceScenarios}), ${a.scenarios} Apogee scenarios`,
  );
}
for (const [f, c] of Object.entries(families).sort((a, b) => a[0].localeCompare(b[0]))) {
  const bands = Object.entries(c.windows ?? {}).map(([w, b]) => `band ${w} x${b.factor.toFixed(3)} (${b.runs})`).join(", ");
  console.log(`  ${f.padEnd(16)} x${c.factor.toFixed(3)} = relative x${c.relative!.toFixed(3)} * category x${c.category!.toFixed(3)}${bands ? `; ${bands}` : ""}`);
}
if (!dry) {
  writeFileSync(dataFile("season-1", "calibration.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log("wrote data/season-1/calibration.json; npm run build:season applies it");
}
