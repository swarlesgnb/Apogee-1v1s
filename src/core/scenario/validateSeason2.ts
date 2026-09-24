/**
 * Hold season 2 to what it claims.
 *
 *   1. data/seasons/season-2.json passes `validateSeason`, and names exactly the scenario
 *      files in data/season-2/scenarios - none missing, none extra, each file's Name= its
 *      own file name, since that is the name KovaaK's lists and keys the board on.
 *      Every profile a file names resolves inside it: player, bots, their characters,
 *      dodge and aim profiles, weapons, abilities. A dangling name is a setting the game
 *      silently drops, which is how a teleport ability once went missing unnoticed.
 *   2. The rules every family shares (tools/season2/design.ts): sixty seconds, no accuracy
 *      multiplier, an "Apogee " name, six families per category, four bands per family.
 *   3. Every threshold reproduces: each file is measured again and the committed model's
 *      predicted board, cut at the pool ladder, gives exactly the season's numbers.
 *   4. Every family's bands are strictly harder by the model's measure.
 *   5. Generated spawn fields keep two limits: nothing more than 45 degrees off centre (the
 *      edge of a 103-degree view is 51.5), and no two spawn points close enough for live
 *      targets on them to overlap.
 *   6. What a player feels - target size, angular speed, reversal period - lies within the
 *      range popular scenarios of the same class span (20,000 players or more). Checked on
 *      the extremes, not the typical, because a season's Expert band is meant to sit near
 *      the hard end; past the end is past anything a player has been asked to do.
 *   7. Nothing a recipe set is outside what real scenarios use. For every numeric key in an
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
import { get, num, parseSce, profile, list, type Sce } from "./sce.ts";
import { jsonSpawns, scenarioFeatures } from "./features.ts";
import { classify, predictLadder, toMetric, type ClassModel } from "./difficulty.ts";
import { thresholdsFrom } from "../season/percentiles.ts";
import { windowRankIndices } from "../season/windows.ts";
import { validateSeason, type Season } from "../season/season.ts";
import { buildCorpus, kovaaksRoot, scenarioFiles } from "../../../tools/scenarioCorpus.ts";

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

let dangling = 0;
for (const [name, { sce }] of sces) {
  const missing: string[] = [];
  const need = (type: string, ref: string | undefined) => {
    const bare = (ref ?? "").replace(/\.(bot|rot|abil\w+)$/i, "");
    if (bare && !profile(sce, type, bare)) missing.push(`${type} ${bare}`);
  };
  const character = (ref: string | undefined) => {
    need("Character Profile", ref);
    const c = profile(sce, "Character Profile", ref ?? "");
    for (const w of list(get(c?.lines ?? [], "WeaponProfileNames"))) need("Weapon Profile", w);
    for (const a of list(get(c?.lines ?? [], "AbilityProfileNames"))) {
      const bare = a.replace(/\.abil\w+$/i, "");
      if (!sce.sections.some((x) => x.type.endsWith("Ability Profile") && get(x.lines, "Name")?.toLowerCase() === bare.toLowerCase())) missing.push(`ability ${a}`);
    }
  };
  character(get(sce.head, "PlayerProfile"));
  for (const entry of list(get(sce.head, "AddedBots"))) {
    need("Bot Profile", entry);
    const bot = profile(sce, "Bot Profile", entry.replace(/\.bot$/i, ""));
    character(get(bot?.lines ?? [], "CharacterProfile"));
    for (const d of list(get(bot?.lines ?? [], "DodgeProfileNames"))) need("Dodge Profile", d);
    for (const a of list(get(bot?.lines ?? [], "AimingProfileNames"))) need("Aim Profile", a);
  }
  if (missing.length) {
    dangling++;
    fail(`${name} names profiles it does not carry: ${[...new Set(missing)].join(", ")}`);
  }
}
if (!dangling) pass("every profile a file names, it carries");

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

// ---- 5. generated spawn fields ------------------------------------------------------------------

const RAD = 180 / Math.PI;
let fieldProblems = 0;
let fields = 0;
for (const [name, { sce }] of sces) {
  if (!(get(sce.head, "MapName") ?? "").startsWith("Apogee ")) continue;
  fields++;
  const raw = sce.sections.find((x) => x.type === "Map Data")?.raw ?? "{}";
  const spawns = jsonSpawns(raw);
  const player = spawns.find((x) => x.teams === 1)?.at ?? { x: 0, y: 0, z: 0 };
  const scale = num(sce.head, "MapScale", 1);
  const bots = spawns.filter((x) => x.teams === 2).map((x) => ({ x: (x.at.x - player.x) * scale, y: (x.at.y - player.y) * scale, z: (x.at.z - player.z) * scale }));
  const botName = list(get(sce.head, "AddedBots"))[0]?.replace(/\.bot$/, "") ?? "";
  const character = profile(sce, "Character Profile", get(profile(sce, "Bot Profile", botName)?.lines ?? [], "CharacterProfile") ?? "");
  const radius = num(character?.lines ?? [], "MainBBRadius", 0) * num(sce.head, "TargetSizeBaseMultiplier", 1);
  const worstYaw = Math.max(...bots.map((v) => Math.abs(Math.atan2(v.y, v.x) * RAD)));
  if (worstYaw > 45 + 1e-6) {
    fieldProblems++;
    fail(`${name}: a spawn sits ${worstYaw.toFixed(1)} degrees off centre`);
  }
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      const a = bots[i], b = bots[j];
      const la = Math.hypot(a.x, a.y, a.z), lb = Math.hypot(b.x, b.y, b.z);
      const apart = Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb)))) * RAD;
      // Half of each target's angular size at its own distance: the two rings of Parallax
      // put targets of two sizes side by side.
      const needed = Math.atan(radius / la) * RAD + Math.atan(radius / lb) * RAD;
      // Only a pair on the same line of sight can overlap on screen; a near target in
      // front of a far one hides it, which a two-depth field accepts.
      if (apart < needed && Math.abs(la - lb) < radius * 2) {
        fieldProblems++;
        fail(`${name}: spawns ${apart.toFixed(2)} degrees apart for targets needing ${needed.toFixed(2)}`);
        i = bots.length;
        break;
      }
    }
  }
}
if (fields === 0) fail("no generated spawn field found to check");
else if (!fieldProblems) pass(`${fields} generated spawn fields: all within 45 degrees, no overlapping spawns`);

// ---- 6. design quantities within what popular scenarios ask -----------------------------------------

const popular = buildCorpus(root).filter((r) => r.catalogue && r.catalogue.entries >= 20_000 && classify(r));
const QUANTITIES: Record<string, (f: ReturnType<typeof scenarioFeatures>) => number | null> = {
  "target size (deg)": (f) => f.derived.targetDeg,
  "angular speed (deg/s)": (f) => ((f.derived.angularSpeed ?? 0) > 1 ? f.derived.angularSpeed : null),
  "reversal period (s)": (f) => ((f.derived.angularSpeed ?? 0) > 1 && (f.derived.strafePeriod ?? 99) < 30 ? f.derived.strafePeriod : null),
};
// A family may declare a quantity it deliberately takes past the popular range, with its
// reason and precedent (tools/season2/design.ts, `exceeds`). Declared is allowed and listed;
// undeclared fails.
const declared = new Map<string, Set<string>>();
const familiesFile = JSON.parse(readFileSync(dataFile("season-2", "families.json"), "utf8")) as { families: Array<{ family: string; exceeds?: Array<{ quantity: string; why: string }> }> };
for (const f of familiesFile.families) for (const e of f.exceeds ?? []) {
  if (!e.why || e.why.length < 40) fail(`${f.family}: an exception needs its reason written out`);
  declared.set(f.family, (declared.get(f.family) ?? new Set()).add(e.quantity));
}
const allowed: string[] = [];
let beyond = 0;
for (const s of season.scenarios) {
  const entry = sces.get(s.scenario);
  if (!entry) continue;
  const f = scenarioFeatures(entry.sce, mapsDir);
  const cls = classify(f);
  const peers = popular.filter((r) => classify(r) === cls);
  for (const [label, measure] of Object.entries(QUANTITIES)) {
    const v = measure(f);
    if (v === null) continue;
    const range = peers.map(measure).filter((x): x is number => x !== null && Number.isFinite(x));
    const lo = Math.min(...range), hi = Math.max(...range);
    if (v < lo || v > hi) {
      if (declared.get(s.family!)?.has(label)) {
        allowed.push(`${s.scenario} (${label} ${v.toFixed(2)})`);
        continue;
      }
      beyond++;
      fail(`${s.scenario}: ${label} ${v.toFixed(2)} is outside ${lo.toFixed(2)}..${hi.toFixed(2)} across ${range.length} popular ${cls} scenarios`);
    }
  }
}
if (!beyond) pass(`every scenario's size, speed and reversal period lie within what ${popular.length} popular scenarios of its class ask, or declare why not`);
if (allowed.length) console.log(`       declared exceptions: ${allowed.join(", ")}`);

// ---- 7. values within what real files use ------------------------------------------------------

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
