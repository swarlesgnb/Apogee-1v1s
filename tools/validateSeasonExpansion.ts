/** Verify the expansion, preservation of the core, and playable two-rank handovers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dataFile } from "../src/core/dataDir.ts";
import { loadSeason, seasonAsDifficulties } from "../src/core/season/season.ts";
import { thresholdsFrom } from "../src/core/season/percentiles.ts";
import { scenarioEnergy, rankIndex } from "../src/core/benchmarks/energy.ts";
import { matchesCategory } from "../src/core/match/scenarioSelection.ts";

const read = (name: string): any => JSON.parse(readFileSync(dataFile(name), "utf8"));
const pool = read("pool.json");
const spec = read("season_expansion.json");
const calibration = read("season_expansion_calibration.json");
const season = loadSeason();
const identity = read("scenario_identity.json").scenarios;
const taxonomy = new Map<string, any>(read("scenario_taxonomy.json").scenarios.map((s: any) => [s.name, s]));
const distributions = new Map<string, any>(read("leaderboard_percentiles.json").distributions.map((d: any) => [d.scenario, d]));
const boards = new Map<string, any>(read("leaderboard_apex.json").boards.map((d: any) => [d.scenario, d]));
const adjustments = new Map<string, any>(calibration.adjustments.map((a: any) => [a.scenario, a]));
const canonical = (v: any): any => v && typeof v === "object"
  ? Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const hash = (v: any) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");

assert.equal(pool.ladder.overlap, 2);
assert.equal(season.windowOverlap, 2);
assert.equal(season.scenarios.length, 252);
assert.equal(new Set(season.scenarios.map(s => s.scenario)).size, 252);
assert.equal(spec.families.length, 24);
assert.equal(calibration.originalFamilies.length, 39);
assert.equal(adjustments.size, 63 * 3);
for (const original of calibration.originalFamilies) {
  const current = pool.families.find((f: any) => f.family === original.family);
  assert(current, `${original.family}: original family removed`);
  const restored = { ...current, variants: current.variants.map((v: any) => ({
    ...v, ...(adjustments.get(v.scenario)?.before ?? {}),
  })) };
  assert.equal(hash(restored), original.sha256, `${original.family}: core changed beyond recorded overlap targets`);
}
for (const f of spec.families) {
  const family = pool.families.find((p: any) => p.family === f.family && p.category === f.category);
  assert.deepEqual(family.variants.map((v: any) => v.scenario), f.rungs);
  for (const v of family.variants) {
    const t = taxonomy.get(v.scenario);
    const i = identity[v.scenario];
    const shipped = season.scenarios.find(s => s.scenario === v.scenario)!;
    assert(t?.expansionVerifiedAt && i && shipped, `${v.scenario}: missing evidence or shipping identity`);
    assert.equal(v.leaderboardId, t.leaderboardId);
    assert.equal(i.leaderboardId, t.leaderboardId);
    assert.equal(shipped.leaderboardId, t.leaderboardId);
    assert.equal(i.subCategory, f.category);
    assert(matchesCategory({ id: i.leaderboardId, name: v.scenario, ...i }, f.category));
    const skill = f.category.endsWith("Clicking") ? "Clicking" : f.category.endsWith("Tracking") ? "Tracking" : "Switching";
    assert.equal(i.aimType, skill, `${v.scenario}: absent from its broad skill queue`);
    assert.deepEqual(shipped.rankMaxes, v.rankMaxes);
    assert(v.rankMaxes.at(-1) <= boards.get(v.scenario).points[0].score);
  }
}
for (const a of calibration.adjustments) {
  const v = pool.families.flatMap((f: any) => f.variants).find((v: any) => v.scenario === a.scenario);
  const d = distributions.get(a.scenario);
  assert.equal(a.sampledAt, d.sampledAt);
  assert.equal(a.recordSampledAt, boards.get(a.scenario).sampledAt);
  const cut = thresholdsFrom(d, a.topFractions)!;
  const first = Math.min(a.record - 1, Math.max(a.before.rankMaxes[4] + 1, cut[0]));
  const second = Math.min(a.record, Math.max(a.before.rankMaxes[5] + 1, cut[1], first + 1));
  assert.deepEqual(v.rankMaxes, [...a.before.rankMaxes.slice(0, 4), first, second]);
  assert.deepEqual(a.rankMaxes, v.rankMaxes);
  assert(first > v.rankMaxes[3] && second > first && second <= a.record);
  if (!a.repairUnreachable) assert(first > a.before.rankMaxes[4] && second > a.before.rankMaxes[5]);
  else assert(a.before.rankMaxes[5] >= a.record);
}
for (const a of calibration.ceilingAdjustments) {
  const d = distributions.get(a.scenario);
  const expected = thresholdsFrom(d, a.before.source.cut.topFractions)!;
  assert.deepEqual(expected, a.before.rankMaxes);
  assert.equal(a.record, Math.floor(boards.get(a.scenario).points[0].score));
  expected[expected.length - 1] = a.record;
  for (let i = expected.length - 2; i >= 0; i--) expected[i] = Math.min(expected[i], expected[i + 1] - 1);
  assert.deepEqual(a.rankMaxes, expected);
  assert.deepEqual(season.scenarios.find(s => s.scenario === a.scenario)!.rankMaxes, expected);
}

// Play only the easier band's scenarios. The real energy path must award both
// names from the next band, and it must cap there even at arbitrarily high scores.
const difficulties = seasonAsDifficulties(season);
for (const category of season.categories) {
  const count = category.name === "Static Clicking" ? 13 : 10;
  for (let band = 0; band < 3; band++) {
    const definition = difficulties[band].categories.find(c => c.name === category.name)!;
    const ladder = category.bands![band];
    assert.equal(definition.scenarios.length, count);
    assert.deepEqual(ladder.rankNames.slice(-2), category.bands![band + 1].rankNames.slice(0, 2));
    for (const step of [4, 5]) {
      const energy = definition.scenarios.reduce((sum, s) => sum + scenarioEnergy(s.rankMaxes[step], s.rankMaxes), 0);
      assert.equal(rankIndex(energy, ladder.rankMaxes), step, `${category.name}/${band}: crossover rank ${step}`);
    }
    const capped = definition.scenarios.reduce((sum, s) => sum + scenarioEnergy(1e12, s.rankMaxes), 0);
    assert.equal(rankIndex(capped, ladder.rankMaxes), 5);
  }
}
console.log(`OK: 96 additions, 39 preserved core families, 189 reproducible overlap adjustments, 18 two-rank handovers through the scoring engine.`);
console.log(`Repaired ${calibration.adjustments.filter((a: any) => a.repairUnreachable).length} previously unreachable crossover tails; all other crossover targets increased.`);
