/**
 * Build season 2: forge every scenario, predict its board, cut its thresholds.
 *
 *   1. Each family in `tools/season2/design.ts` is built at four bands on its template,
 *      read from the local KovaaK's install, and written to data/season-2/scenarios.
 *   2. Each built file is measured by `core/scenario/features.ts` - the same code that
 *      measured the corpus the difficulty model learned from, so the model sees these
 *      scenarios exactly as it saw the ones it was fitted on.
 *   3. The model predicts the board; the pool's percentile ladder is read off it at the
 *      ranks each band grades, the way `buildSeason` reads it off a sampled board.
 *   4. data/seasons/season-2.json is written with season 1's rank names, colours, windows
 *      and category guides - those are the season owner's and are carried, not remade -
 *      and with energy thresholds derived from season 2's family counts.
 *
 * Refuses to write anything if a scenario lands in the wrong difficulty class for its
 * category, or if a family's bands do not get strictly harder by the model's own measure:
 * a band that is predicted easier than the one below it is a design mistake, and the file
 * is not the place to discover it.
 *
 *   npx tsx tools/buildSeason2.ts [--dry]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../src/core/dataDir.ts";
import { ENERGY_PER_RANK } from "../src/core/benchmarks/energy.ts";
import { parseSce, serializeSce, get, type Sce } from "../src/core/scenario/sce.ts";
import { scenarioFeatures, type ScenarioFeatures } from "../src/core/scenario/features.ts";
import { classify, predictLadder, toMetric, type ClassModel, type DifficultyClass } from "../src/core/scenario/difficulty.ts";
import { thresholdsFrom } from "../src/core/season/percentiles.ts";
import { windowRankCount, windowRankIndices } from "../src/core/season/windows.ts";
import { validateSeason, type Season, type SeasonScenario } from "../src/core/season/season.ts";
import { kovaaksRoot, scenarioFiles } from "./scenarioCorpus.ts";
import { BANDS, FAMILIES, TEMPLATES, buildScenario, scenarioName, type Band, type Category } from "./season2/design.ts";

const dry = process.argv.includes("--dry");
const root = kovaaksRoot();
if (!root) {
  console.error("No KovaaK's install found; the templates are read from it.");
  process.exit(1);
}
const mapsDir = join(root, "maps");

// ---- templates -------------------------------------------------------------------------

const wanted = new Set<string>(Object.values(TEMPLATES));
const templates = new Map<string, { sce: Sce; file: string }>();
for (const file of scenarioFiles(root)) {
  const text = readFileSync(file, "utf8");
  const name = /^Name=(.*)$/m.exec(text)?.[1]?.trim();
  if (name && wanted.has(name) && !templates.has(name)) templates.set(name, { sce: parseSce(text), file });
}
const missing = [...wanted].filter((n) => !templates.has(n));
if (missing.length) {
  console.error(`Templates not found in the local scenario or workshop folders: ${missing.join(", ")}`);
  process.exit(1);
}

// ---- model and ladder ------------------------------------------------------------------

const modelFile = JSON.parse(readFileSync(dataFile("season-2", "difficulty_model.json"), "utf8")) as { models: ClassModel[]; fittedAt: string };
const models = new Map(modelFile.models.map((m) => [m.class, m]));
const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as { ladder: { ranks: number[]; overlap: number }; windowSize: number; windows: string[] };
const ladder = pool.ladder.ranks;
const windowSize = pool.windowSize;
const overlap = pool.ladder.overlap;
const totalRanks = ladder.length;

const EXPECTED: Record<Category, DifficultyClass> = {
  "Static Clicking": "click",
  "Dynamic Clicking": "click",
  "Precise Tracking": "track",
  "Reactive Tracking": "track",
  "Speed Switching": "switch",
  "Evasive Switching": "switch",
};

// ---- build -----------------------------------------------------------------------------

interface Built {
  family: (typeof FAMILIES)[number];
  band: Band;
  name: string;
  text: string;
  features: ScenarioFeatures;
  cls: DifficultyClass;
  prediction: ReturnType<typeof predictLadder>;
  rankMaxes: number[];
  /** The model's metric at the board median: the difficulty measure bands are checked on. */
  medianMetric: number;
}

const problems: string[] = [];
const built: Built[] = [];
for (const family of FAMILIES) {
  const template = templates.get(TEMPLATES[family.template])!;
  for (const band of [0, 1, 2, 3] as Band[]) {
    const name = scenarioName(family, band);
    let sce: Sce;
    try {
      sce = buildScenario(template.sce, family, band);
    } catch (err) {
      problems.push(`${name}: ${(err as Error).message}`);
      continue;
    }
    const text = serializeSce(sce);
    const features = scenarioFeatures(parseSce(text), mapsDir);
    const cls = classify(features);
    if (cls !== EXPECTED[family.category]) {
      problems.push(`${name}: classified ${cls ?? "as nothing"}, ${family.category} expects ${EXPECTED[family.category]}`);
      continue;
    }
    const prediction = predictLadder(models.get(cls)!, features);
    const dist = { scenario: name, leaderboardId: 0, total: 0, points: prediction.points.map((p) => ({ topFraction: p.topFraction, score: p.score })), sampledAt: modelFile.fittedAt };
    const ranks = windowRankIndices(band, windowSize, totalRanks, overlap).map((i) => ladder[i]);
    const rankMaxes = thresholdsFrom(dist, ranks);
    if (!rankMaxes) {
      problems.push(`${name}: the predicted board does not reach every rank's percentile`);
      continue;
    }
    const median = prediction.points.find((p) => p.topFraction === 0.5)!.score;
    built.push({ family, band, name, text, features, cls, prediction, rankMaxes, medianMetric: toMetric(cls, features, median) ?? NaN });
  }
}

// Bands must get harder. For clicking the metric is log seconds per kill, which rises with
// difficulty; for the share classes it is the logit of the share earned, which falls.
for (const family of FAMILIES) {
  const rows = built.filter((b) => b.family === family).sort((a, b) => a.band - b.band);
  for (let i = 1; i < rows.length; i++) {
    const harder = rows[i].cls === "click" ? rows[i].medianMetric > rows[i - 1].medianMetric : rows[i].medianMetric < rows[i - 1].medianMetric;
    if (!harder) problems.push(`${family.name}: ${BANDS[rows[i].band]} is not predicted harder than ${BANDS[rows[i - 1].band]}`);
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s); nothing written:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// ---- season ----------------------------------------------------------------------------

const season1 = JSON.parse(readFileSync(dataFile("seasons", "season-1.json"), "utf8")) as Season & Record<string, unknown>;
const categories = season1.categories.map((c) => {
  const families = new Set(FAMILIES.filter((f) => f.category === c.name).map((f) => f.name)).size;
  const perRank = families * ENERGY_PER_RANK;
  return {
    ...c,
    bands: (c.bands ?? []).map((b) => ({
      ...b,
      rankMaxes: Array.from({ length: windowRankCount(b.window, windowSize, totalRanks, overlap) }, (_, i) => perRank * (i + 1)),
    })),
    rankMaxes: Array.from({ length: c.rankNames.length }, (_, i) => perRank * (i + 1)),
  };
});

const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places;
const scenarios: Array<SeasonScenario & Record<string, unknown>> = built.map((b) => ({
  scenario: b.name,
  category: b.family.category,
  family: b.family.name,
  arm: b.family.arm,
  armFrom: "Apogee",
  subCategory: b.family.subCategory,
  window: b.band,
  label: b.family.name,
  focus: b.family.focus,
  // No board exists until the scenario is shared in game; see docs/season-2.md.
  leaderboardId: null,
  rankMaxes: b.rankMaxes,
  source: {
    kind: "predicted",
    why: `Read off the board ${b.cls === "click" ? "the clicking" : b.cls === "track" ? "the tracking" : "the switching"} model predicts for this file, at the pool ladder's percentiles for the ranks this band grades. The model's leave-one-out median error at the board median is ${round(models.get(b.cls)!.fits.find((f) => f.topFraction === 0.5)!.looMedian)} in its own units; see data/season-2/difficulty_model.json. Seeded: recut from Apogee's own runs once there are enough.`,
  },
}));

const season: Season & Record<string, unknown> = {
  name: "Season 2",
  status: "draft",
  rankNames: season1.rankNames,
  rankColors: season1.rankColors,
  windowSize,
  windowOverlap: overlap,
  windows: pool.windows,
  matchPool: season1.matchPool,
  categories,
  thresholds: {
    owner: "tools/buildSeason2.ts",
    note:
      "Every threshold in this season is predicted, not sampled: no scenario in it has a KovaaK's board yet. Each was read off the board the difficulty model predicts from the scenario file, at the same ladder percentiles season 1 cuts from real boards. They are seeds to be recut from Apogee's own runs, and every one says so in its source.",
    model: { fittedAt: modelFile.fittedAt, file: "data/season-2/difficulty_model.json" },
  },
  builtAt: new Date().toISOString(),
  scenarios,
};
validateSeason(season);

// ---- write -------------------------------------------------------------------------------

const outDir = dataFile("season-2", "scenarios");
const summary = built.map((b) => ({
  scenario: b.name,
  family: b.family.name,
  band: BANDS[b.band],
  class: b.cls,
  targetDeg: round(b.features.derived.targetDeg ?? 0),
  angularSpeed: round(b.features.derived.angularSpeed ?? 0, 1),
  fittsIdNearest: b.features.derived.fittsIdNearest === null ? null : round(b.features.derived.fittsIdNearest),
  ttk: b.features.derived.ttk === null ? null : round(b.features.derived.ttk),
  median: Math.round(b.prediction.points.find((p) => p.topFraction === 0.5)!.score),
  medianRange: (() => {
    const p = b.prediction.points.find((q) => q.topFraction === 0.5)!;
    return [Math.round(p.low), Math.round(p.high)];
  })(),
  rankMaxes: b.rankMaxes,
}));

if (dry) {
  for (const s of summary) console.log(`${s.scenario.padEnd(40)} ${s.class.padEnd(6)} deg=${s.targetDeg} spd=${s.angularSpeed} id=${s.fittsIdNearest} ttk=${s.ttk} median=${s.median} [${s.medianRange}] ${s.rankMaxes.join(" ")}`);
  process.exit(0);
}

if (existsSync(outDir)) {
  // Only ever the files this tool wrote: every one is named "Apogee ...".
  for (const f of readdirSync(outDir)) if (/^Apogee .*\.sce$/.test(f)) rmSync(join(outDir, f));
}
mkdirSync(outDir, { recursive: true });
for (const b of built) writeFileSync(join(outDir, `${b.name}.sce`), b.text);
writeFileSync(dataFile("seasons", "season-2.json"), JSON.stringify(season, null, 2) + "\n");
writeFileSync(
  dataFile("season-2", "families.json"),
  JSON.stringify(
    {
      $comment: "Written by tools/buildSeason2.ts from tools/season2/design.ts; do not hand-edit.",
      families: FAMILIES.map((f) => ({
        family: f.name,
        category: f.category,
        focus: f.focus,
        why: f.why,
        learnsFrom: f.learnsFrom,
        template: TEMPLATES[f.template],
        arm: f.arm,
        ...(f.exceeds ? { exceeds: f.exceeds } : {}),
      })),
      scenarios: summary,
    },
    null,
    1,
  ) + "\n",
);
// A readable sheet of every scenario, for playtesting and tuning. Generated, like the rank
// sheet, so the numbers in it are the numbers in the files.
const fmt = (v: number | null, digits = 1) => (v === null || !Number.isFinite(v) || v === 0 ? "-" : v.toFixed(digits));
const lines: string[] = [
  "# Season 2 scenarios",
  "",
  "Generated by `npm run build:season-2` from `tools/season2/design.ts`; do not edit by hand.",
  "Sizes and speeds are what the player sees, at the distance the target is shot at. The",
  "predicted median is the board model's, with its leave-one-out median error either side;",
  "the thresholds are read off the same prediction (docs/season-2-research.md).",
  "",
];
for (const category of [...new Set(FAMILIES.map((f) => f.category))]) {
  lines.push(`## ${category}`, "");
  for (const family of FAMILIES.filter((f) => f.category === category)) {
    lines.push(`### ${family.name}`, "", `${family.focus} ${family.why}`, "");
    lines.push("| Band | Size (deg) | Speed (deg/s) | Reversal (s) | Kill (s) | Predicted median | Thresholds |", "| --- | ---: | ---: | ---: | ---: | --- | --- |");
    for (const b of built.filter((x) => x.family === family).sort((x, y) => x.band - y.band)) {
      const d = b.features.derived;
      const moving = (d.angularSpeed ?? 0) > 1;
      const p = b.prediction.points.find((q) => q.topFraction === 0.5)!;
      lines.push(
        `| ${BANDS[b.band]} | ${fmt(d.targetDeg, 2)} | ${moving ? fmt(d.angularSpeed) : "still"} | ${moving && (d.strafePeriod ?? 99) < 30 ? fmt(d.strafePeriod, 2) : "-"} | ${b.cls === "switch" ? fmt(d.ttk, 2) : "-"} | ${Math.round(p.score)} (${Math.round(p.low)}-${Math.round(p.high)}) | ${b.rankMaxes.join(", ")} |`,
      );
    }
    lines.push("");
  }
}
writeFileSync(join(dataFile(".."), "docs", "season-2-scenarios.md"), lines.join("\n"));

console.log(`${built.length} scenarios, ${FAMILIES.length} families -> data/season-2/scenarios, data/seasons/season-2.json, docs/season-2-scenarios.md`);
void get;
