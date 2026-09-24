/**
 * Hold season 2 to what it claims.
 *
 *   1. data/seasons/season-2.json passes `validateSeason`, and names exactly the scenario
 *      files in data/season-2/scenarios - none missing, none extra, each file's Name= its
 *      own file name, since that is the name KovaaK's lists and keys the board on.
 *   2. The rules every family shares (tools/season2/design.ts): sixty seconds, no accuracy
 *      multiplier, an "Apogee " name, six families per category, four bands per family.
 *   3. Every threshold reproduces: each file is measured again and the committed model's
 *      predicted board, cut at the pool ladder, gives exactly the season's numbers.
 *   4. Every family's bands are strictly harder by the model's measure.
 *   5. Nothing a recipe set is outside what real scenarios use. For every numeric key in an
 *      authored file's profiles, the value must lie within the range that key takes across
 *      the scenario files on this machine. No scenario here has been played in game, so the
 *      one thing that can be checked is that the game has loaded values like these before.
 *
 * Needs the KovaaK's install for 3 and 5 (the maps folder and the corpus). A missing
 * install fails rather than skipping, because a skipped check is a check that passed
 * without looking.
 *
 *   npm run validate:season2
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dataFile } from "../dataDir.ts";
import { get, parseSce, type Sce } from "./sce.ts";
import { scenarioFeatures } from "./features.ts";
import { classify, predictLadder, toMetric, type ClassModel } from "./difficulty.ts";
import { thresholdsFrom } from "../season/percentiles.ts";
import { windowRankIndices } from "../season/windows.ts";
import { validateSeason, type Season } from "../season/season.ts";
import { kovaaksRoot, scenarioFiles } from "../../../tools/scenarioCorpus.ts";

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const pass = (msg: string) => console.log(`  ok   ${msg}`);

const root = kovaaksRoot();
if (!root) {
  console.log("FAIL no KovaaK's install; thresholds and value ranges cannot be checked");
  process.exit(1);
}

const season = JSON.parse(readFileSync(dataFile("seasons", "season-2.json"), "utf8")) as Season;
try {
  validateSeason(season);
  pass(`season-2.json is a valid season (${season.scenarios.length} scenarios)`);
} catch (err) {
  fail(`season-2.json: ${(err as Error).message}`);
}

// ---- 1. files ------------------------------------------------------------------------------

const dir = dataFile("season-2", "scenarios");
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sce")) : [];
const named = new Set(season.scenarios.map((s) => s.scenario));
const onDisk = new Set(files.map((f) => f.replace(/\.sce$/, "")));
const missing = [...named].filter((n) => !onDisk.has(n));
const extra = [...onDisk].filter((n) => !named.has(n));
if (missing.length) fail(`no file for: ${missing.join(", ")}`);
if (extra.length) fail(`files the season does not name: ${extra.join(", ")}`);
if (!missing.length && !extra.length) pass(`${files.length} files, one per season scenario`);

const sces = new Map<string, { sce: Sce; text: string }>();
for (const f of files) {
  const text = readFileSync(join(dir, f), "utf8");
  const sce = parseSce(text);
  sces.set(f.replace(/\.sce$/, ""), { sce, text });
  if (get(sce.head, "Name") !== f.replace(/\.sce$/, "")) fail(`${f}: Name= is ${get(sce.head, "Name")}`);
}

// ---- 2. shared rules -------------------------------------------------------------------------

let ruleBreaks = 0;
for (const [name, { sce }] of sces) {
  const broke = (why: string) => {
    ruleBreaks++;
    fail(`${name}: ${why}`);
  };
  if (!name.startsWith("Apogee ")) broke("name does not start with Apogee");
  if (get(sce.head, "Timelimit") !== "60.0") broke(`Timelimit=${get(sce.head, "Timelimit")}`);
  if (get(sce.head, "ScoreMultAccuracy") !== "false") broke("accuracy multiplier is on");
  if (!(get(sce.head, "SearchTags") ?? "").includes("Apogee Season 2")) broke("not tagged Apogee Season 2");
}
const byCategory = new Map<string, Map<string, Set<number>>>();
for (const s of season.scenarios) {
  const fams = byCategory.get(s.category) ?? new Map<string, Set<number>>();
  fams.set(s.family!, (fams.get(s.family!) ?? new Set()).add(s.window!));
  byCategory.set(s.category, fams);
}
for (const [cat, fams] of byCategory) {
  if (fams.size !== 6) fail(`${cat} has ${fams.size} families, not 6`);
  for (const [fam, windows] of fams) if (windows.size !== 4) fail(`${fam} has ${windows.size} bands, not 4`);
}
if (byCategory.size !== 6) fail(`${byCategory.size} categories, not 6`);
if (!ruleBreaks) pass("60 seconds, no accuracy multiplier, Apogee names and tags on every file");

// ---- 3 and 4. thresholds and band order -------------------------------------------------------

const model = JSON.parse(readFileSync(dataFile("season-2", "difficulty_model.json"), "utf8")) as { models: ClassModel[] };
const pool = JSON.parse(readFileSync(dataFile("pool.json"), "utf8")) as { ladder: { ranks: number[]; overlap: number }; windowSize: number };
const mapsDir = join(root, "maps");
const metrics = new Map<string, { band: number; metric: number; click: boolean }[]>();
let reproduced = 0;
for (const s of season.scenarios) {
  const entry = sces.get(s.scenario);
  if (!entry) continue;
  const features = scenarioFeatures(entry.sce, mapsDir);
  const cls = classify(features);
  const m = model.models.find((x) => x.class === cls);
  if (!cls || !m) {
    fail(`${s.scenario}: no difficulty class`);
    continue;
  }
  const prediction = predictLadder(m, features);
  const dist = { scenario: s.scenario, leaderboardId: 0, total: 0, sampledAt: "", points: prediction.points.map((p) => ({ topFraction: p.topFraction, score: p.score })) };
  const ranks = windowRankIndices(s.window!, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap).map((i) => pool.ladder.ranks[i]);
  const expected = thresholdsFrom(dist, ranks);
  if (JSON.stringify(expected) === JSON.stringify(s.rankMaxes)) reproduced++;
  else fail(`${s.scenario}: thresholds ${s.rankMaxes.join(" ")} but the model gives ${expected?.join(" ")}`);
  const median = prediction.points.find((p) => p.topFraction === 0.5)!.score;
  const list = metrics.get(s.family!) ?? [];
  list.push({ band: s.window!, metric: toMetric(cls, features, median) ?? NaN, click: cls === "click" });
  metrics.set(s.family!, list);
}
if (reproduced === season.scenarios.length) pass(`all ${reproduced} threshold rows reproduce from the committed model`);

let disordered = 0;
for (const [family, list] of metrics) {
  list.sort((a, b) => a.band - b.band);
  for (let i = 1; i < list.length; i++) {
    const harder = list[i].click ? list[i].metric > list[i - 1].metric : list[i].metric < list[i - 1].metric;
    if (!harder) {
      disordered++;
      fail(`${family}: band ${list[i].band} is not predicted harder than band ${list[i].band - 1}`);
    }
  }
}
if (!disordered) pass(`every family's bands get strictly harder (${metrics.size} families)`);

// ---- 5. values within what real files use ------------------------------------------------------

const PROFILE_TYPES = new Set(["Character Profile", "Bot Profile", "Dodge Profile", "Weapon Profile"]);
const ranges = new Map<string, { min: number; max: number }>();
for (const file of scenarioFiles(root)) {
  let sce: Sce;
  try {
    sce = parseSce(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  for (const section of sce.sections) {
    if (!PROFILE_TYPES.has(section.type)) continue;
    for (const { key, value } of section.lines) {
      if (!/^-?\d+(\.\d+)?$/.test(value)) continue;
      const v = Number(value);
      const k = `${section.type}.${key}`;
      const r = ranges.get(k);
      if (!r) ranges.set(k, { min: v, max: v });
      else {
        r.min = Math.min(r.min, v);
        r.max = Math.max(r.max, v);
      }
    }
  }
}
let outOfRange = 0;
const seenOut = new Set<string>();
for (const [name, { sce }] of sces) {
  for (const section of sce.sections) {
    if (!PROFILE_TYPES.has(section.type)) continue;
    for (const { key, value } of section.lines) {
      if (!/^-?\d+(\.\d+)?$/.test(value)) continue;
      const r = ranges.get(`${section.type}.${key}`);
      const v = Number(value);
      if (r && (v < r.min - 1e-9 || v > r.max + 1e-9)) {
        outOfRange++;
        const k = `${section.type}.${key}`;
        if (!seenOut.has(k)) fail(`${name}: ${k}=${value} is outside ${r.min}..${r.max} seen across ${ranges.size ? "the corpus" : ""}`);
        seenOut.add(k);
      }
    }
  }
}
if (!outOfRange) pass(`every profile value lies within the range real scenario files use (${ranges.size} keys measured)`);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nseason 2 holds");
