/** Check the live circuit, exact identities, reproducible targets and historical boundary. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dataFile } from "../src/core/dataDir.ts";
import { loadSeason, seasonAsDifficulties, validateSeason } from "../src/core/season/season.ts";
import { thresholdsFrom } from "../src/core/season/percentiles.ts";
import { windowRankIndices } from "../src/core/season/windows.ts";
import { practicePlaylists } from "../src/core/season/practice.ts";
import { matchesCategory } from "../src/core/match/scenarioSelection.ts";
import { rankIndex, scenarioEnergy } from "../src/core/benchmarks/energy.ts";
import { beforeEvasiveSeason } from "./evasiveReworkHistory.ts";

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
const spec = read("evasive_rework.json");
const calibration = read("evasive_rework_calibration.json");
const evidence = read("evasive_rework_evidence.json").identities;
const pool = read("pool.json");
const season = loadSeason();
validateSeason(beforeEvasiveSeason(season));
const identity = read("scenario_identity.json").scenarios;
const distributions = new Map<string, any>(read("leaderboard_percentiles.json").distributions.map((s: any) => [s.scenario, s]));
const boards = new Map<string, any>(read("leaderboard_apex.json").boards.map((s: any) => [s.scenario, s]));
const families = pool.families.filter((f: any) => f.category === spec.category);
const withoutFocus = ({ focus, ...f }: any): any => f;
// Record repairs came later and are checked in validateSeasonExpansion; undo them here too.
const repairedBefore = new Map<string, any>(read("record_repairs.json").repairs.map((r: any) => [r.scenario, r.before]));
const unrepaired = (f: any): any => ({ ...f, variants: f.variants.map((v: any) => ({ ...v, ...(repairedBefore.get(v.scenario) ?? {}) })) });
assert.equal(createHash("sha256").update(JSON.stringify(pool.families.filter((f: any) => f.category !== spec.category).map(unrepaired).map(withoutFocus))).digest("hex"),
  calibration.otherFamiliesSha256, "Other category selections or targets changed");
assert.equal(families.length, 11);
assert.equal(season.scenarios.length, 256);
assert.equal(new Set(season.scenarios.map(s => s.scenario)).size, 256);
assert.deepEqual(families.map((f: any) => f.family), spec.families.map((f: any) => f.family));
const changed = spec.families.filter((f: any) => f.changed);
assert.equal(calibration.adjustments.length, changed.length * 4);

for (const f of spec.families) {
  const current = families.find((c: any) => c.family === f.family);
  assert.deepEqual(current.variants.map((v: any) => v.scenario), f.rungs);
  if (!f.changed) assert.deepEqual(withoutFocus(current), withoutFocus(calibration.beforeFamilies.find((old: any) => old.family === f.family)));
  for (const v of current.variants) {
    const shipped = season.scenarios.find(s => s.scenario === v.scenario)!;
    assert(shipped && shipped.category === spec.category && shipped.window === v.window);
    assert.deepEqual(shipped.rankMaxes, v.rankMaxes);
    assert.equal(shipped.leaderboardId, v.leaderboardId);
    assert.equal(identity[v.scenario].leaderboardId, v.leaderboardId);
    for (const category of [spec.category, "Switching"]) {
      assert(matchesCategory({ id: v.leaderboardId, name: v.scenario, ...identity[v.scenario] }, category));
    }
    if (!f.changed) continue;
    assert.equal(evidence[v.scenario].leaderboardId, v.leaderboardId);
    assert(evidence[v.scenario].verifiedAt && evidence[v.scenario].url);
    const a = calibration.adjustments.find((a: any) => a.scenario === v.scenario);
    const d = distributions.get(v.scenario); const board = boards.get(v.scenario);
    const ranks = windowRankIndices(v.window, pool.windowSize, pool.ladder.ranks.length, pool.ladder.overlap);
    const fractions = ranks.map((r, i) => pool.ladder.ranks[r] * (v.window < 3 && i >= 4 ? [0.5, 0.4][i - 4] : 1));
    assert.deepEqual(a.ranks, ranks); assert.deepEqual(a.topFractions, fractions);
    assert.equal(a.sampledAt, d.sampledAt); assert.equal(a.recordSampledAt, board.sampledAt);
    assert.equal(a.record, Math.floor(board.points[0].score));
    let expected = thresholdsFrom(d, fractions)!;
    assert.deepEqual(a.raw, expected);
    expected[expected.length - 1] = Math.min(a.record, expected.at(-1)!);
    for (let i = expected.length - 2; i >= 0; i--) expected[i] = Math.min(expected[i], expected[i + 1] - 1);
    const previous = calibration.beforeFamilies.flatMap((f: any) => f.variants)
      .find((old: any) => old.scenario === v.scenario && old.window === v.window);
    assert.equal(a.mode, previous ? "preserved" : "recut");
    if (previous) {
      expected = previous.rankMaxes;
      assert.deepEqual(v.source, previous.source);
    }
    assert.deepEqual(v.rankMaxes, expected); assert.deepEqual(a.rankMaxes, expected);
    assert(expected[0] > 0 && expected.every((x, i) => i === 0 || x > expected[i - 1]));
    assert(expected.at(-1)! <= a.record);
  }
}

// Guard the actual regressions: a Hard edit cannot return to the novice playlist,
// and the old low-population expert and mixed-author Domi choice are retired.
const novice = families.map((f: any) => f.variants[0].scenario);
assert(novice.every((name: string) => !/\bHard\b|\bElite\b|\bRegen\b/.test(name)));
for (const name of ["tamTargetSwitch Smooth Hard 30% Larger", "domiSwitch Avasive", "SmoothTS Revosect"]) {
  assert(!season.scenarios.some(s => s.scenario === name));
}
for (const stem of ["VT FlyTS", "VT Penta Bounce", "VT ControlTS", "VT DriftTS"]) {
  const entry = evidence[`${stem} Entry S5 Speed`];
  assert(/15% slower/.test(entry.description) && /-25% TTK/.test(entry.description));
}
assert(/15% larger, 15% slower/.test(evidence["VT PasuTS Entry S5"].description));
for (const name of ["Floatswitch Entry", "Floatswitch Intermediate", "Floatswitch Advanced", "Floatswitch Elite"]) {
  assert(/20 hits/.test(evidence[name].description) && /0\.2s/.test(evidence[name].description));
}

const playlists = practicePlaylists(season);
const difficulties = seasonAsDifficulties(season);
const category = season.categories.find(c => c.name === spec.category)!;
for (let window = 0; window < 4; window++) {
  assert.deepEqual(playlists.find(p => p.category === spec.category && p.window === window)!.scenarios,
    spec.families.map((f: any) => f.rungs[window]));
  const definition = difficulties[window].categories.find(c => c.name === spec.category)!;
  const band = category.bands![window];
  for (let step = 0; step < band.rankMaxes.length; step++) {
    const energy = definition.scenarios.reduce((sum, s) => sum + scenarioEnergy(s.rankMaxes[step], s.rankMaxes), 0);
    assert.equal(rankIndex(energy, band.rankMaxes), step);
  }
  if (window < 3) assert.deepEqual(band.rankNames.slice(-2), category.bands![window + 1].rankNames.slice(0, 2));
}
console.log(`OK: 11 evasive families, 44 playable scenarios, ${calibration.adjustments.length} reproducible targets, novice mechanics and four band ladders.`);
